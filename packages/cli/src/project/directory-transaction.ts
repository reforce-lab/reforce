import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, realpath, rmdir, unlink } from "node:fs/promises";
import { join, relative } from "node:path";
import type { GeneratedFile } from "@reforce/compiler";
import {
  compareUtf16CodeUnits,
  isPathContained,
  isPathStrictlyContained,
  isRelativePosixPath,
  toPortablePath,
} from "@reforce/primitives";
import { isObject } from "radashi";
import { hasExactKeys } from "@/project/exact-keys";
import { isMissingPathError, pathExists } from "@/project/fs-error";
import { validateGeneratedManifestBytes } from "@/project/generated-manifest";
import { ProjectBusyError, type ProjectLease } from "@/project/lease";
import { renameWithWindowsRetry } from "@/project/windows-rename-retry";

type TransactionKind = "generated" | "dist";
type TransactionState = "prepared" | "backup-published" | "active-published" | "verified";

interface TransactionFileRecord {
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
}

interface TransactionJournal {
  readonly schemaVersion: 1;
  readonly transactionToken: string;
  readonly leaseOwnerToken: string;
  readonly kind: TransactionKind;
  readonly state: TransactionState;
  readonly hadActiveBefore: boolean;
  readonly files: readonly TransactionFileRecord[];
  readonly aggregateSha256: string;
  readonly previousFiles: readonly TransactionFileRecord[];
  readonly previousAggregateSha256: string | null;
}

interface TransactionFaultContext {
  readonly kind: TransactionKind;
  readonly transactionToken: string;
  readonly path?: string;
}

type TransactionFaultInjector = (
  point: string,
  context: TransactionFaultContext,
) => void | Promise<void>;

interface PreparedDistTransaction {
  readonly transactionToken: string;
  readonly stagingDirectory: string;
}

interface CommitDistOptions extends PreparedDistTransaction {
  readonly expectedFiles: readonly string[];
}

interface DirectoryTransactionOptions {
  readonly projectRoot: string;
  readonly lease: ProjectLease;
  readonly faultInjector?: TransactionFaultInjector;
}

// The compiler owns which files land in `.reforce/generated`, and commitGenerated rejects any set
// that is not exactly this list, so drift in either direction would only surface as a runtime
// failure. Routing the list through this helper makes both directions typecheck failures: the
// `const T extends` bound rejects a path the compiler never emits, and the `Exclude<...> extends
// never` guard collapses the parameter to `never` once the compiler emits a path this list lacks
// (Issue #22).
function exactGeneratedFilePaths<const T extends readonly GeneratedFile["path"][]>(
  paths: T & (Exclude<GeneratedFile["path"], T[number]> extends never ? unknown : never),
): T {
  return paths;
}

const generatedFilePaths = exactGeneratedFilePaths([
  "beans.ts",
  "bootstrap.ts",
  "manifest.json",
  "qualifiers.d.ts",
  "routes.json",
  "routes.ts",
  "weaving.json",
]);

interface TransactionPaths {
  readonly active: string;
  readonly backup: string;
  readonly journalDirectory: string;
  readonly journalFile: string;
  readonly staging: string;
}

// On-disk layout per transaction kind. The directory names and the `<kind>.staging-` /
// `<kind>.backup-` prefixes derived from it are disk protocol: recovery scans parent
// directories for exactly these prefixes, so they must stay byte-for-byte stable.
interface TransactionLayout {
  // Directory holding the active tree and its staging/backup siblings.
  readonly activeParent: string;
  // Root under `.reforce/transactions` holding this kind's journal metadata.
  readonly transactionRoot: string;
}

interface TreeSnapshot {
  readonly files: readonly TransactionFileRecord[];
  readonly aggregateSha256: string;
}

interface TreeEntry {
  readonly path: string;
  readonly bytes: Uint8Array;
}

function transactionRootFor(reforceRoot: string, kind: TransactionKind): string {
  return join(reforceRoot, "transactions", kind);
}

function stagingPrefix(kind: TransactionKind): string {
  return `${kind}.staging-`;
}

function backupPrefix(kind: TransactionKind): string {
  return `${kind}.backup-`;
}

export interface IncompleteDistTransaction {
  // journal：`.reforce/transactions/dist` 下还留着事务记录；artifact：项目根还留着 staging/backup 目录。
  readonly reason: "journal" | "artifact";
  readonly entryName: string;
}

// start 命令要在启动前确认 dist 不是半个事务的产物，而判断依据是本模块的磁盘命名（见
// TransactionLayout）。放在这里而不是由 start 自己拼路径：那边拼错或这边改名都不会让任何一方编译
// 失败，只会让检查静默失效，于是 reforce start 直接跑在撕裂的 dist 上。
export async function findIncompleteDistTransaction(
  projectRoot: string,
): Promise<IncompleteDistTransaction | undefined> {
  const journalRoot = transactionRootFor(join(projectRoot, ".reforce"), "dist");
  const journalEntries = await readdirIfExists(journalRoot);
  const journalEntry = journalEntries[0];
  if (journalEntry !== undefined) {
    return { reason: "journal", entryName: journalEntry };
  }
  const artifactEntry = (await readdir(projectRoot)).find(
    (entry) => entry.startsWith(stagingPrefix("dist")) || entry.startsWith(backupPrefix("dist")),
  );
  return artifactEntry === undefined ? undefined : { reason: "artifact", entryName: artifactEntry };
}

async function readdirIfExists(directory: string): Promise<readonly string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if (isMissingPathError(error)) {
      return [];
    }
    throw error;
  }
}

class FifoMutex {
  private tail = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const { promise: current, resolve: release } = Promise.withResolvers<void>();
    const previous = this.tail;
    this.tail = previous.then(() => current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export class DirectoryTransactionError extends Error {
  readonly code: "GENERATED_TRANSACTION_FAILED" | "DIST_TRANSACTION_FAILED";

  constructor(kind: TransactionKind, message: string, options: { readonly cause?: unknown } = {}) {
    super(message, options);
    this.name = "DirectoryTransactionError";
    this.code = kind === "generated" ? "GENERATED_TRANSACTION_FAILED" : "DIST_TRANSACTION_FAILED";
  }
}

// collectTreeEntries 用它区分「这棵树不是合法的事务树」和「这棵树根本没读成」：只有前者可以被
// validateTreeAgainstSnapshot 降级成「与快照不符」（Issue #105）。
class TreeShapeError extends Error {}

function boundaryViolationMessage(target: string): string {
  return `Transaction path is outside its required boundary: ${target}`;
}

// 严格变体：root 自身必须判为越界（同 removeTree，理由见那里的 Issue #55 注释）。
// create() 专用，所以抛普通 Error：那一步还没有任何事务，没有 kind 可归属；事务内部的越界必须带 kind
// 抛 DirectoryTransactionError，否则会绕过 commit 的错误归类（Issue #105）。
function assertContained(root: string, target: string): void {
  if (isPathStrictlyContained(root, target)) {
    return;
  }
  throw new Error(boundaryViolationMessage(target));
}

function createFileHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function createAggregateHash(entries: readonly TreeEntry[]): string {
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(Buffer.from(entry.path, "utf8"));
    hash.update("\0");
    hash.update(String(entry.bytes.byteLength));
    hash.update("\0");
    hash.update(entry.bytes);
  }
  return hash.digest("hex");
}

async function collectTreeEntries(root: string, directory = root): Promise<readonly TreeEntry[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => compareUtf16CodeUnits(left.name, right.name));
  const collected: TreeEntry[] = [];
  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new TreeShapeError(`Transaction trees cannot contain symbolic links: ${absolutePath}`);
    }
    if (entry.isDirectory()) {
      collected.push(...(await collectTreeEntries(root, absolutePath)));
      continue;
    }
    if (!entry.isFile()) {
      throw new TreeShapeError(`Transaction trees only support ordinary files: ${absolutePath}`);
    }
    collected.push({
      path: toPortablePath(relative(root, absolutePath)),
      bytes: await readFile(absolutePath),
    });
  }
  collected.sort((left, right) => compareUtf16CodeUnits(left.path, right.path));
  return collected;
}

// 导出仅供 it/recovery/directory-transaction.spec.ts：它要伪造「崩溃在写入中途」的 journal，
// 即一份与已被改动的目录树相符、但与事务记录不符的快照。真实入口只会写「与当前树一致」的快照，
// 无法构造这种状态。测试若自己重算哈希，就会把这里的拼接规则复制一份——改了聚合算法两边同步跟着改，
// 回归测试照绿而存量 journal 已全部失效（Issue #35）。
export async function snapshotTree(root: string): Promise<TreeSnapshot> {
  return summarizeTree(await collectTreeEntries(root));
}

function summarizeTree(entries: readonly TreeEntry[]): TreeSnapshot {
  return {
    files: entries.map((entry) => ({
      path: entry.path,
      byteLength: entry.bytes.byteLength,
      sha256: createFileHash(entry.bytes),
    })),
    aggregateSha256: createAggregateHash(entries),
  };
}

function sameFileRecords(
  left: readonly TransactionFileRecord[],
  right: readonly TransactionFileRecord[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.path === right[index]?.path &&
        entry.byteLength === right[index]?.byteLength &&
        entry.sha256 === right[index]?.sha256,
    )
  );
}

function sameSortedPaths(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && expected.every((path, index) => actual[index] === path)
  );
}

// 接收已经收好的 entries 而不是自己再遍历一遍：调用方无一例外都是先 snapshot 再校验结构，
// 各自读一遍等于把整棵树的 readFile 和 sha256 做两次——dist 树是整个应用产物，generated 树在
// dev 下每次文件改动都要过一遍。
function validateTreeStructure(kind: TransactionKind, entries: readonly TreeEntry[]): boolean {
  const paths = entries.map((entry) => entry.path);
  if (kind === "generated") {
    if (!sameSortedPaths(paths, generatedFilePaths)) {
      return false;
    }
    const manifest = entries.find((entry) => entry.path === "manifest.json");
    return manifest !== undefined && validateGeneratedManifestBytes(manifest.bytes);
  }
  return paths.includes("main.mjs");
}

async function validateTreeAgainstJournal(
  root: string,
  journal: TransactionJournal,
): Promise<boolean> {
  return await validateTreeAgainstSnapshot(
    root,
    journal.kind,
    journal.files,
    journal.aggregateSha256,
  );
}

async function validatePreviousTreeAgainstJournal(
  root: string,
  journal: TransactionJournal,
): Promise<boolean> {
  if (!journal.hadActiveBefore || journal.previousAggregateSha256 === null) {
    return false;
  }
  return await validateTreeAgainstSnapshot(
    root,
    journal.kind,
    journal.previousFiles,
    journal.previousAggregateSha256,
  );
}

async function validateTreeAgainstSnapshot(
  root: string,
  kind: TransactionKind,
  files: readonly TransactionFileRecord[],
  aggregateSha256: string,
): Promise<boolean> {
  try {
    const entries = await collectTreeEntries(root);
    const snapshot = summarizeTree(entries);
    if (!sameFileRecords(snapshot.files, files) || snapshot.aggregateSha256 !== aggregateSha256) {
      return false;
    }
    return validateTreeStructure(kind, entries);
  } catch (error) {
    // 只有「树不存在」和「树的形状本身不合法」才等价于「与快照不符」。EACCES/EIO/EMFILE 说明这棵树根本
    // 没读成，把它压成 false 会让 recoverPublished 把完好的新一代当成不匹配、删掉后回滚到上一代
    // （Issue #105，规则见 fs-error.ts）。
    if (isMissingPathError(error) || error instanceof TreeShapeError) {
      return false;
    }
    throw error;
  }
}

function parseFileRecord(value: unknown): TransactionFileRecord | undefined {
  if (!isObject(value) || !hasExactKeys(value, ["path", "byteLength", "sha256"])) {
    return undefined;
  }
  const path = Reflect.get(value, "path");
  const byteLength = Reflect.get(value, "byteLength");
  const sha256 = Reflect.get(value, "sha256");
  if (
    typeof path !== "string" ||
    typeof byteLength !== "number" ||
    !Number.isInteger(byteLength) ||
    byteLength < 0 ||
    typeof sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(sha256) ||
    !isRelativePosixPath(path)
  ) {
    return undefined;
  }
  return { path, byteLength, sha256 };
}

function parseFileRecords(value: unknown): readonly TransactionFileRecord[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const files: TransactionFileRecord[] = [];
  for (const entry of value) {
    const file = parseFileRecord(entry);
    if (!file) {
      return undefined;
    }
    files.push(file);
  }
  const sortedPaths = files.map((file) => file.path).sort(compareUtf16CodeUnits);
  if (
    files.some((file, index) => file.path !== sortedPaths[index]) ||
    new Set(sortedPaths).size !== sortedPaths.length
  ) {
    return undefined;
  }
  return files;
}

function parseJournal(
  value: unknown,
  expectedKind: TransactionKind,
  expectedToken: string,
): TransactionJournal | undefined {
  if (
    !isObject(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "transactionToken",
      "leaseOwnerToken",
      "kind",
      "state",
      "hadActiveBefore",
      "files",
      "aggregateSha256",
      "previousFiles",
      "previousAggregateSha256",
    ])
  ) {
    return undefined;
  }
  const schemaVersion = Reflect.get(value, "schemaVersion");
  const transactionToken = Reflect.get(value, "transactionToken");
  const leaseOwnerToken = Reflect.get(value, "leaseOwnerToken");
  const kind = Reflect.get(value, "kind");
  const state = Reflect.get(value, "state");
  const hadActiveBefore = Reflect.get(value, "hadActiveBefore");
  const filesValue = Reflect.get(value, "files");
  const aggregateSha256 = Reflect.get(value, "aggregateSha256");
  const previousFilesValue = Reflect.get(value, "previousFiles");
  const previousAggregateSha256 = Reflect.get(value, "previousAggregateSha256");
  if (
    schemaVersion !== 1 ||
    transactionToken !== expectedToken ||
    typeof leaseOwnerToken !== "string" ||
    kind !== expectedKind ||
    (state !== "prepared" &&
      state !== "backup-published" &&
      state !== "active-published" &&
      state !== "verified") ||
    typeof hadActiveBefore !== "boolean" ||
    typeof aggregateSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(aggregateSha256) ||
    (previousAggregateSha256 !== null &&
      (typeof previousAggregateSha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(previousAggregateSha256)))
  ) {
    return undefined;
  }
  const files = parseFileRecords(filesValue);
  const previousFiles = parseFileRecords(previousFilesValue);
  if (
    files === undefined ||
    previousFiles === undefined ||
    (hadActiveBefore && previousAggregateSha256 === null) ||
    (!hadActiveBefore && (previousFiles.length !== 0 || previousAggregateSha256 !== null))
  ) {
    return undefined;
  }
  return {
    schemaVersion,
    transactionToken,
    leaseOwnerToken,
    kind: expectedKind,
    state,
    hadActiveBefore,
    files,
    aggregateSha256,
    previousFiles,
    previousAggregateSha256,
  };
}

export class DirectoryTransactions {
  private readonly faultInjector?: TransactionFaultInjector;
  private readonly lease: ProjectLease;
  private readonly mutex = new FifoMutex();
  private readonly projectRoot: string;
  private readonly reforceRoot: string;
  private readonly generatedTransactionRoot: string;
  private readonly distTransactionRoot: string;

  private constructor(input: {
    readonly projectRoot: string;
    readonly reforceRoot: string;
    readonly generatedTransactionRoot: string;
    readonly distTransactionRoot: string;
    readonly lease: ProjectLease;
    readonly faultInjector?: TransactionFaultInjector;
  }) {
    this.projectRoot = input.projectRoot;
    this.reforceRoot = input.reforceRoot;
    this.generatedTransactionRoot = input.generatedTransactionRoot;
    this.distTransactionRoot = input.distTransactionRoot;
    this.lease = input.lease;
    this.faultInjector = input.faultInjector;
  }

  static async create(options: DirectoryTransactionOptions): Promise<DirectoryTransactions> {
    const projectRoot = await realpath(options.projectRoot);
    if (projectRoot !== options.lease.projectRoot) {
      throw new Error("Transaction project root does not match the writer lease identity.");
    }
    const reforceRoot = join(projectRoot, ".reforce");
    await mkdir(reforceRoot, { recursive: true });
    const canonicalReforceRoot = await realpath(reforceRoot);
    assertContained(projectRoot, canonicalReforceRoot);
    const generatedTransactionRoot = transactionRootFor(canonicalReforceRoot, "generated");
    const distTransactionRoot = transactionRootFor(canonicalReforceRoot, "dist");
    await mkdir(generatedTransactionRoot, { recursive: true });
    await mkdir(distTransactionRoot, { recursive: true });
    const canonicalGeneratedTransactionRoot = await realpath(generatedTransactionRoot);
    const canonicalDistTransactionRoot = await realpath(distTransactionRoot);
    assertContained(canonicalReforceRoot, canonicalGeneratedTransactionRoot);
    assertContained(canonicalReforceRoot, canonicalDistTransactionRoot);
    return new DirectoryTransactions({
      projectRoot,
      reforceRoot: canonicalReforceRoot,
      generatedTransactionRoot: canonicalGeneratedTransactionRoot,
      distTransactionRoot: canonicalDistTransactionRoot,
      lease: options.lease,
      faultInjector: options.faultInjector,
    });
  }

  async prepareDist(): Promise<PreparedDistTransaction> {
    return await this.mutex.run(async () => {
      await this.lease.assertCurrentWriter();
      const transactionToken = randomUUID();
      const paths = this.paths("dist", transactionToken);
      await this.hit("before:mkdir:staging", "dist", transactionToken, paths.staging);
      await mkdir(paths.staging);
      await this.hit("after:mkdir:staging", "dist", transactionToken, paths.staging);
      return { transactionToken, stagingDirectory: paths.staging };
    });
  }

  async commitGenerated(files: readonly GeneratedFile[]): Promise<void> {
    await this.mutex.run(async () => {
      await this.lease.assertCurrentWriter();
      const transactionToken = randomUUID();
      const paths = this.paths("generated", transactionToken);
      const sortedFiles = [...files].sort((left, right) =>
        compareUtf16CodeUnits(left.path, right.path),
      );
      if (
        !sameSortedPaths(
          sortedFiles.map((file) => file.path),
          generatedFilePaths,
        )
      ) {
        throw new DirectoryTransactionError(
          "generated",
          "Generated output must contain the exact public file set.",
        );
      }

      await this.hit("before:mkdir:staging", "generated", transactionToken, paths.staging);
      await mkdir(paths.staging);
      await this.hit("after:mkdir:staging", "generated", transactionToken, paths.staging);
      try {
        for (const file of sortedFiles) {
          await this.writeFile(
            join(paths.staging, file.path),
            file.content,
            "generated",
            transactionToken,
          );
        }
        await this.commitPrepared("generated", transactionToken, paths, generatedFilePaths);
      } catch (error) {
        await this.recoverTokenIfJournalExists("generated", transactionToken, paths);
        throw error instanceof DirectoryTransactionError
          ? error
          : new DirectoryTransactionError("generated", "Generated output transaction failed.", {
              cause: error,
            });
      }
    });
  }

  async commitDist(options: CommitDistOptions): Promise<void> {
    await this.mutex.run(async () => {
      await this.lease.assertCurrentWriter();
      const paths = this.paths("dist", options.transactionToken);
      if (paths.staging !== options.stagingDirectory) {
        throw new DirectoryTransactionError(
          "dist",
          "Dist staging path does not match its transaction token.",
        );
      }
      const expectedFiles = [...new Set(options.expectedFiles)].sort(compareUtf16CodeUnits);
      if (!expectedFiles.includes("main.mjs")) {
        throw new DirectoryTransactionError("dist", "Dist output must include main.mjs.");
      }
      for (const path of expectedFiles) {
        if (!isRelativePosixPath(path)) {
          throw new DirectoryTransactionError("dist", `Invalid transaction file path: ${path}`);
        }
      }
      try {
        await this.commitPrepared("dist", options.transactionToken, paths, expectedFiles);
      } catch (error) {
        await this.recoverTokenIfJournalExists("dist", options.transactionToken, paths);
        throw error instanceof DirectoryTransactionError
          ? error
          : new DirectoryTransactionError("dist", "Production output transaction failed.", {
              cause: error,
            });
      }
    });
  }

  async recover(): Promise<void> {
    await this.mutex.run(async () => {
      await this.lease.assertCurrentWriter();
      for (const kind of ["generated", "dist"] as const) {
        const { transactionRoot } = this.layoutFor(kind);
        const entries = await readdir(transactionRoot, { withFileTypes: true });
        entries.sort((left, right) => compareUtf16CodeUnits(left.name, right.name));
        for (const entry of entries) {
          if (!entry.isDirectory()) {
            throw new DirectoryTransactionError(
              kind,
              `Invalid transaction metadata entry: ${entry.name}`,
            );
          }
          const paths = this.paths(kind, entry.name);
          if (await pathExists(paths.journalFile)) {
            await this.recoverJournal(kind, entry.name, paths);
          } else {
            await this.recoverJournalOrphan(kind, entry.name, paths);
          }
        }
        await this.recoverUnjournaledStaging(kind);
      }
    });
  }

  private async recoverUnjournaledStaging(kind: TransactionKind): Promise<void> {
    const layout = this.layoutFor(kind);
    const prefix = stagingPrefix(kind);
    const entries = await readdir(layout.activeParent, { withFileTypes: true });
    entries.sort((left, right) => compareUtf16CodeUnits(left.name, right.name));
    for (const entry of entries) {
      if (!entry.name.startsWith(prefix)) {
        continue;
      }
      if (!entry.isDirectory()) {
        throw new DirectoryTransactionError(
          kind,
          `Invalid staging transaction entry: ${entry.name}`,
        );
      }
      const transactionToken = entry.name.slice(prefix.length);
      const paths = this.paths(kind, transactionToken);
      if (await pathExists(paths.journalDirectory)) {
        continue;
      }
      if (await pathExists(paths.backup)) {
        throw new DirectoryTransactionError(
          kind,
          "Unjournaled staging output has an associated backup.",
        );
      }
      await this.removeTree(paths.staging, kind, transactionToken);
    }
  }

  private async commitPrepared(
    kind: TransactionKind,
    transactionToken: string,
    paths: TransactionPaths,
    expectedFiles: readonly string[],
  ): Promise<void> {
    const stagingEntries = await collectTreeEntries(paths.staging);
    const snapshot = summarizeTree(stagingEntries);
    if (
      !sameSortedPaths(
        snapshot.files.map((file) => file.path),
        expectedFiles,
      ) ||
      !validateTreeStructure(kind, stagingEntries)
    ) {
      throw new DirectoryTransactionError(
        kind,
        "Staging output failed exact file-set or schema validation.",
      );
    }
    const hadActiveBefore = await pathExists(paths.active);
    let previousSnapshot: TreeSnapshot | undefined;
    if (hadActiveBefore) {
      const activeEntries = await collectTreeEntries(paths.active);
      previousSnapshot = summarizeTree(activeEntries);
      if (!validateTreeStructure(kind, activeEntries)) {
        throw new DirectoryTransactionError(
          kind,
          "Previous active output failed exact file-set or schema validation.",
        );
      }
    }
    const journal: TransactionJournal = {
      schemaVersion: 1,
      transactionToken,
      leaseOwnerToken: this.lease.leaseToken,
      kind,
      state: "prepared",
      hadActiveBefore,
      files: snapshot.files,
      aggregateSha256: snapshot.aggregateSha256,
      previousFiles: previousSnapshot?.files ?? [],
      previousAggregateSha256: previousSnapshot?.aggregateSha256 ?? null,
    };
    // The journal is always written BEFORE the disk mutation it announces: state advances
    // prepared → backup-published → active-published → verified, and recoverJournal mirrors
    // this order, resuming from the last persisted state after a crash. Reordering the
    // write/rename pairs below breaks crash recovery.
    await this.writeJournal(paths, journal);

    if (hadActiveBefore) {
      await this.rename(paths.active, paths.backup, kind, transactionToken, "active-to-backup");
    }
    await this.writeJournal(paths, { ...journal, state: "backup-published" });
    await this.rename(paths.staging, paths.active, kind, transactionToken, "staging-to-active");
    await this.writeJournal(paths, { ...journal, state: "active-published" });
    await this.hit("before:verification-read", kind, transactionToken, paths.active);
    const activeIsValid = await validateTreeAgainstJournal(paths.active, journal);
    await this.hit("after:verification-close", kind, transactionToken, paths.active);
    if (!activeIsValid) {
      throw new DirectoryTransactionError(
        kind,
        "Published output did not match its transaction journal.",
      );
    }
    await this.writeJournal(paths, { ...journal, state: "verified" });
    if (hadActiveBefore) {
      await this.removeTree(paths.backup, kind, transactionToken);
    }
    await this.removeTree(paths.journalDirectory, kind, transactionToken);
  }

  private async recoverTokenIfJournalExists(
    kind: TransactionKind,
    transactionToken: string,
    paths: TransactionPaths,
  ): Promise<void> {
    if (await pathExists(paths.journalFile)) {
      await this.recoverJournal(kind, transactionToken, paths);
      return;
    }
    if (await pathExists(paths.staging)) {
      await this.removeTree(paths.staging, kind, transactionToken);
    }
    if (await pathExists(paths.journalDirectory)) {
      await this.recoverJournalOrphan(kind, transactionToken, paths);
    }
  }

  private async recoverJournal(
    kind: TransactionKind,
    transactionToken: string,
    paths: TransactionPaths,
  ): Promise<void> {
    await this.lease.assertCurrentWriter();
    const journal = await this.adoptJournal(
      await this.readJournal(paths, kind, transactionToken),
      paths,
    );
    const activeMatches = await validateTreeAgainstJournal(paths.active, journal);
    const stagingMatches = await validateTreeAgainstJournal(paths.staging, journal);
    const activeMatchesPrevious = await validatePreviousTreeAgainstJournal(paths.active, journal);
    const backupMatchesPrevious = await validatePreviousTreeAgainstJournal(paths.backup, journal);
    const validations = {
      activeMatches,
      stagingMatches,
      activeMatchesPrevious,
      backupMatchesPrevious,
    };
    switch (journal.state) {
      case "prepared":
        await this.recoverPrepared(journal, paths, validations);
        break;
      case "backup-published":
        await this.recoverBackupPublished(journal, paths, validations);
        break;
      // Both post-publish states share one recovery path: the new generation is already
      // active, or the backup has to be restored.
      case "active-published":
      case "verified":
        await this.recoverPublished(journal, paths, validations);
        break;
    }
    await this.validateRecoveredActive(journal, paths);
    await this.cleanupRecoveredTransaction(journal, paths);
  }

  private async adoptJournal(
    journal: TransactionJournal,
    paths: TransactionPaths,
  ): Promise<TransactionJournal> {
    if (journal.leaseOwnerToken === this.lease.leaseToken) {
      return journal;
    }
    const recoveredWriterToken = journal.leaseOwnerToken;
    if (!this.lease.canRecoverWriterToken(recoveredWriterToken)) {
      throw new ProjectBusyError(this.projectRoot);
    }
    const adopted = { ...journal, leaseOwnerToken: this.lease.leaseToken };
    await this.writeJournal(paths, adopted);
    this.lease.consumeRecoveredWriterToken(recoveredWriterToken);
    return adopted;
  }

  private async recoverPrepared(
    journal: TransactionJournal,
    paths: TransactionPaths,
    validation: {
      readonly activeMatchesPrevious: boolean;
      readonly backupMatchesPrevious: boolean;
    },
  ): Promise<void> {
    if (await pathExists(paths.staging)) {
      await this.removeTree(paths.staging, journal.kind, journal.transactionToken);
    }
    if (!journal.hadActiveBefore) {
      if (await pathExists(paths.active)) {
        throw new DirectoryTransactionError(
          journal.kind,
          "Recovery found an active output that has no previous generation record.",
        );
      }
      return;
    }
    if (validation.activeMatchesPrevious) {
      return;
    }
    if (!validation.backupMatchesPrevious) {
      throw new DirectoryTransactionError(
        journal.kind,
        "Recovery could not verify the previous generation.",
      );
    }
    await this.restoreBackup(journal, paths);
  }

  private async recoverBackupPublished(
    journal: TransactionJournal,
    paths: TransactionPaths,
    validation: {
      readonly activeMatches: boolean;
      readonly stagingMatches: boolean;
      readonly backupMatchesPrevious: boolean;
    },
  ): Promise<void> {
    if (validation.activeMatches) {
      if (await pathExists(paths.staging)) {
        await this.removeTree(paths.staging, journal.kind, journal.transactionToken);
      }
      return;
    }
    if (validation.stagingMatches) {
      await this.replaceActive(paths.staging, journal, paths, "recovery-staging-to-active");
      return;
    }
    if (validation.backupMatchesPrevious) {
      await this.restoreBackup(journal, paths);
      return;
    }
    throw new DirectoryTransactionError(
      journal.kind,
      "Recovery found no complete output generation.",
    );
  }

  private async recoverPublished(
    journal: TransactionJournal,
    paths: TransactionPaths,
    validation: { readonly activeMatches: boolean; readonly backupMatchesPrevious: boolean },
  ): Promise<void> {
    if (validation.activeMatches) {
      return;
    }
    if (!validation.backupMatchesPrevious) {
      throw new DirectoryTransactionError(
        journal.kind,
        "Recovery found no complete output generation.",
      );
    }
    if (await pathExists(paths.active)) {
      await this.removeTree(paths.active, journal.kind, journal.transactionToken);
    }
    await this.restoreBackup(journal, paths);
  }

  private async restoreBackup(journal: TransactionJournal, paths: TransactionPaths): Promise<void> {
    await this.replaceActive(paths.backup, journal, paths, "recovery-backup-to-active");
  }

  private async replaceActive(
    source: string,
    journal: TransactionJournal,
    paths: TransactionPaths,
    label: string,
  ): Promise<void> {
    if (await pathExists(paths.active)) {
      await this.removeTree(paths.active, journal.kind, journal.transactionToken);
    }
    await this.rename(source, paths.active, journal.kind, journal.transactionToken, label);
  }

  private async validateRecoveredActive(
    journal: TransactionJournal,
    paths: TransactionPaths,
  ): Promise<void> {
    if (journal.state === "prepared") {
      if (!journal.hadActiveBefore && !(await pathExists(paths.active))) {
        return;
      }
      if (await validatePreviousTreeAgainstJournal(paths.active, journal)) {
        return;
      }
      throw new DirectoryTransactionError(
        journal.kind,
        "Recovered active output did not match the previous generation.",
      );
    }
    const matchesPost = await validateTreeAgainstJournal(paths.active, journal);
    const matchesPrevious = await validatePreviousTreeAgainstJournal(paths.active, journal);
    if (!matchesPost && !matchesPrevious) {
      throw new DirectoryTransactionError(
        journal.kind,
        "Recovered active output did not match a complete transaction generation.",
      );
    }
  }

  private async cleanupRecoveredTransaction(
    journal: TransactionJournal,
    paths: TransactionPaths,
  ): Promise<void> {
    for (const leftover of [paths.staging, paths.backup]) {
      if (await pathExists(leftover)) {
        await this.removeTree(leftover, journal.kind, journal.transactionToken);
      }
    }
    await this.removeTree(paths.journalDirectory, journal.kind, journal.transactionToken);
  }

  private async recoverJournalOrphan(
    kind: TransactionKind,
    transactionToken: string,
    paths: TransactionPaths,
  ): Promise<void> {
    await this.lease.assertCurrentWriter();
    if (await pathExists(paths.backup)) {
      throw new DirectoryTransactionError(
        kind,
        "Transaction metadata is incomplete while owned output remains.",
      );
    }
    if (await pathExists(paths.staging)) {
      await this.removeTree(paths.staging, kind, transactionToken);
    }
    if (await pathExists(paths.journalDirectory)) {
      await this.removeTree(paths.journalDirectory, kind, transactionToken);
    }
  }

  private async readJournal(
    paths: TransactionPaths,
    kind: TransactionKind,
    transactionToken: string,
  ): Promise<TransactionJournal> {
    await this.hit("before:journal-read", kind, transactionToken, paths.journalFile);
    const bytes = await readFile(paths.journalFile);
    await this.hit("after:journal-close", kind, transactionToken, paths.journalFile);
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
      throw new DirectoryTransactionError(kind, "Transaction journal is not valid JSON.", {
        cause: error,
      });
    }
    const journal = parseJournal(value, kind, transactionToken);
    if (!journal) {
      throw new DirectoryTransactionError(kind, "Transaction journal failed schema validation.");
    }
    return journal;
  }

  // Durability protocol: the journal is serialized to a fresh temporary file, read back and
  // verified byte-for-byte, then published with an atomic rename, so a crash can never leave
  // a truncated or half-written journal.json behind.
  private async writeJournal(paths: TransactionPaths, journal: TransactionJournal): Promise<void> {
    await this.lease.assertCurrentWriter();
    await this.hit(
      "before:mkdir:journal",
      journal.kind,
      journal.transactionToken,
      paths.journalDirectory,
    );
    await mkdir(paths.journalDirectory, { recursive: true });
    await this.hit(
      "after:mkdir:journal",
      journal.kind,
      journal.transactionToken,
      paths.journalDirectory,
    );
    const temporaryPath = join(paths.journalDirectory, `journal-${randomUUID()}.json`);
    const serializedJournal = `${JSON.stringify(journal, undefined, 2)}\n`;
    await this.writeFile(
      temporaryPath,
      serializedJournal,
      journal.kind,
      journal.transactionToken,
      "journal",
    );
    await this.hit(
      "before:journal-verification-read",
      journal.kind,
      journal.transactionToken,
      temporaryPath,
    );
    const written = await readFile(temporaryPath);
    await this.hit(
      "after:journal-verification-close",
      journal.kind,
      journal.transactionToken,
      temporaryPath,
    );
    const writtenJournal = new TextDecoder().decode(written);
    // 字节比较必须排在解析前：截断正是这次回读要抓的情况（见上方协议注释），而截断的文件几乎不是合法
    // JSON，先解析会把它变成裸 SyntaxError，从 recover() → recoverJournal → adoptJournal 一路无 catch
    // 逃出模块、绕过错误分类（Issue #105）。比较通过后 writtenJournal 就等于 serializedJournal，
    // JSON.parse 不会抛。
    if (writtenJournal !== serializedJournal) {
      throw new DirectoryTransactionError(journal.kind, "Transaction journal verification failed.");
    }
    const parsed = parseJournal(JSON.parse(writtenJournal), journal.kind, journal.transactionToken);
    if (
      !parsed ||
      parsed.state !== journal.state ||
      parsed.leaseOwnerToken !== journal.leaseOwnerToken
    ) {
      throw new DirectoryTransactionError(journal.kind, "Transaction journal verification failed.");
    }
    await this.rename(
      temporaryPath,
      paths.journalFile,
      journal.kind,
      journal.transactionToken,
      "journal-publish",
    );
  }

  private async writeFile(
    path: string,
    content: string | Uint8Array,
    kind: TransactionKind,
    transactionToken: string,
    label = "file",
  ): Promise<void> {
    await this.hit(`before:${label}-write`, kind, transactionToken, path);
    const handle = await open(path, "wx");
    // Errors are accumulated with ??= instead of thrown immediately so that the
    // before/after:*-close fault-injection points and handle.close() still run in this fixed
    // order after a write failure; it/recovery evidence tests inject faults at exactly these
    // points, and reordering them invalidates the recovery evidence.
    let operationError: unknown;
    try {
      await handle.writeFile(content);
      await handle.sync();
      await this.hit(`after:${label}-write`, kind, transactionToken, path);
    } catch (error) {
      operationError = error;
    } finally {
      try {
        await this.hit(`before:${label}-close`, kind, transactionToken, path);
      } catch (error) {
        operationError ??= error;
      }
      try {
        await handle.close();
      } catch (error) {
        operationError ??= error;
      }
      try {
        await this.hit(`after:${label}-close`, kind, transactionToken, path);
      } catch (error) {
        operationError ??= error;
      }
    }
    if (operationError !== undefined) {
      throw operationError;
    }
  }

  private async rename(
    source: string,
    destination: string,
    kind: TransactionKind,
    transactionToken: string,
    label: string,
  ): Promise<void> {
    await this.lease.assertCurrentWriter();
    await this.hit(`before:${label}-rename`, kind, transactionToken, source);
    await renameWithWindowsRetry(source, destination);
    await this.hit(`after:${label}-rename`, kind, transactionToken, destination);
  }

  private async removeTree(
    target: string,
    kind: TransactionKind,
    transactionToken: string,
  ): Promise<void> {
    await this.lease.assertCurrentWriter();
    // Safety boundary against deleting the wrong tree: target and boundary are both
    // canonicalized, so a symlink swapped in between the check and the delete resolves to its
    // real location here and fails containment instead of escaping it.
    const [canonicalTarget, canonicalBoundary] = await Promise.all([
      realpath(target),
      realpath(this.boundaryFor(kind, target)),
    ]);
    // 严格包含：校验通过后就开始逐条递归删除，若 target realpath 后等于边界本身，放行就是把用户项目根
    // 删空（Issue #55）。这里跑在 commitDist/commitGenerated 的 catch 里，裸 Error 会从那层 catch
    // 逃出去、绕过错误归类，所以带 kind 抛（Issue #105）。
    if (!isPathStrictlyContained(canonicalBoundary, canonicalTarget)) {
      throw new DirectoryTransactionError(kind, boundaryViolationMessage(canonicalTarget));
    }
    await this.removeDirectoryContents(target, kind, transactionToken);
  }

  private async removeDirectoryContents(
    directory: string,
    kind: TransactionKind,
    transactionToken: string,
  ): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareUtf16CodeUnits(left.name, right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new DirectoryTransactionError(
          kind,
          `Transaction cleanup refused a symbolic link: ${path}`,
        );
      }
      if (entry.isDirectory()) {
        await this.removeDirectoryContents(path, kind, transactionToken);
        continue;
      }
      if (!entry.isFile()) {
        throw new DirectoryTransactionError(
          kind,
          `Transaction cleanup refused a non-file entry: ${path}`,
        );
      }
      await this.hit("before:file-delete", kind, transactionToken, path);
      await unlink(path);
      await this.hit("after:file-delete", kind, transactionToken, path);
    }
    await this.hit("before:directory-delete", kind, transactionToken, directory);
    await rmdir(directory);
    await this.hit("after:directory-delete", kind, transactionToken, directory);
  }

  private boundaryFor(kind: TransactionKind, target: string): string {
    const layout = this.layoutFor(kind);
    // Journal metadata always lives under `.reforce/transactions/<kind>`, so it answers to
    // reforceRoot regardless of kind: for dist that tightens the boundary from projectRoot down to
    // `.reforce`, for generated it is the same directory activeParent already names. Containment
    // rather than a string prefix: a prefix test also matches a sibling that merely starts with
    // the same characters.
    if (isPathContained(layout.transactionRoot, target)) {
      return this.reforceRoot;
    }
    return layout.activeParent;
  }

  private paths(kind: TransactionKind, transactionToken: string): TransactionPaths {
    if (!/^[A-Za-z0-9-]+$/u.test(transactionToken)) {
      throw new DirectoryTransactionError(kind, "Transaction token has an invalid shape.");
    }
    const layout = this.layoutFor(kind);
    const journalDirectory = join(layout.transactionRoot, transactionToken);
    return {
      active: join(layout.activeParent, kind),
      staging: join(layout.activeParent, `${stagingPrefix(kind)}${transactionToken}`),
      backup: join(layout.activeParent, `${backupPrefix(kind)}${transactionToken}`),
      journalDirectory,
      journalFile: join(journalDirectory, "journal.json"),
    };
  }

  private async hit(
    point: string,
    kind: TransactionKind,
    transactionToken: string,
    path?: string,
  ): Promise<void> {
    await this.faultInjector?.(point, {
      kind,
      transactionToken,
      path,
    });
  }

  private layoutFor(kind: TransactionKind): TransactionLayout {
    switch (kind) {
      case "generated":
        return {
          activeParent: this.reforceRoot,
          transactionRoot: this.generatedTransactionRoot,
        };
      case "dist":
        return {
          activeParent: this.projectRoot,
          transactionRoot: this.distTransactionRoot,
        };
    }
  }
}
