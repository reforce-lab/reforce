import { randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { compareUtf16CodeUnits, isPathStrictlyContained } from "@reforce/primitives";
import { isObject, sleep } from "radashi";
import { hasExactKeys } from "@/project/exact-keys";
import {
  type LeaseParticipant,
  type LeaseProbeResult,
  LivenessEndpoint,
  probeLeaseEndpoint,
} from "@/project/lease-endpoint";
import {
  publishMissingDestinationWithWindowsRetry,
  renameWithWindowsRetry,
} from "@/project/windows-rename-retry";

type ProjectLeaseMode = "writer" | "reader";

interface LeaseOwnerRecord {
  readonly schemaVersion: 1;
  readonly mode: ProjectLeaseMode;
  readonly leaseToken: string;
  readonly participants: readonly LeaseParticipant[];
  readonly pid?: number;
}

interface AcquireProjectLeaseOptions {
  readonly projectRoot: string;
  readonly mode: ProjectLeaseMode;
  readonly probeTimeoutMilliseconds?: number;
  readonly gateWaitMilliseconds?: number;
}

interface GateRecord {
  readonly schemaVersion: 1;
  readonly gateToken: string;
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly challenge: string;
}

function randomToken(): string {
  return randomBytes(32).toString("hex");
}

// 严格变体：root 自身必须判为越界。safeRemoveDirectory 校验通过后直接 rm -r，若 `.reforce` 是指向
// 项目根的 symlink，realpath 后 target 与 root 相等，放行就是递归删掉用户项目根（Issue #55）。
function assertContained(root: string, target: string): void {
  if (isPathStrictlyContained(root, target)) {
    return;
  }
  throw new Error(`Lease path is outside its required boundary: ${target}`);
}

async function safeRemoveDirectory(target: string, boundary: string): Promise<void> {
  try {
    const [canonicalBoundary, canonicalTarget, targetStats] = await Promise.all([
      realpath(boundary),
      realpath(target),
      lstat(target),
    ]);
    assertContained(canonicalBoundary, canonicalTarget);
    if (!targetStats.isDirectory()) {
      throw new Error(`Lease cleanup target is not a directory: ${target}`);
    }
    await rm(target, { recursive: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

// "wx" refuses to overwrite an existing record; fsync guarantees the record survives a crash
// so other processes can read it before the publisher continues.
async function writeJsonClosed(path: string, value: unknown): Promise<void> {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// A record that survives parsing is handed straight to probeLeaseEndpoint, and node:net rejects an
// out-of-range port by throwing ERR_SOCKET_BAD_PORT synchronously. A corrupt lease record must
// surface as ProjectBusyError, so the range is enforced here rather than at the socket (#24).
function isValidPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535;
}

// 导出给 start 命令：它从子进程 IPC 收到的 participant 与写进 lease 记录的是同一份线上结构，
// 各自解析就等于把上面的端口范围规则（#24）抄两份，改一处不会强制另一处跟着改。
export function parseParticipant(value: unknown): LeaseParticipant | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  if (!hasExactKeys(value, ["participantToken", "host", "port", "challenge", "role"])) {
    return undefined;
  }
  const participantToken = Reflect.get(value, "participantToken");
  const host = Reflect.get(value, "host");
  const port = Reflect.get(value, "port");
  const challenge = Reflect.get(value, "challenge");
  const role = Reflect.get(value, "role");
  if (
    typeof participantToken !== "string" ||
    host !== "127.0.0.1" ||
    !isValidPort(port) ||
    typeof challenge !== "string" ||
    (role !== "parent" && role !== "child")
  ) {
    return undefined;
  }
  return { participantToken, host, port, challenge, role };
}

function parseOwnerRecord(value: unknown): LeaseOwnerRecord | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  if (!hasExactKeys(value, ["schemaVersion", "mode", "leaseToken", "participants"], ["pid"])) {
    return undefined;
  }
  const schemaVersion = Reflect.get(value, "schemaVersion");
  const mode = Reflect.get(value, "mode");
  const leaseToken = Reflect.get(value, "leaseToken");
  const participantsValue = Reflect.get(value, "participants");
  const pid = Reflect.get(value, "pid");
  if (
    schemaVersion !== 1 ||
    (mode !== "writer" && mode !== "reader") ||
    typeof leaseToken !== "string" ||
    !Array.isArray(participantsValue) ||
    participantsValue.length === 0 ||
    (pid !== undefined && (typeof pid !== "number" || !Number.isInteger(pid)))
  ) {
    return undefined;
  }
  const participants: LeaseParticipant[] = [];
  for (const entry of participantsValue) {
    const participant = parseParticipant(entry);
    if (!participant) {
      return undefined;
    }
    participants.push(participant);
  }
  return {
    schemaVersion,
    mode,
    leaseToken,
    participants,
    ...(pid === undefined ? {} : { pid }),
  };
}

function parseGateRecord(value: unknown): GateRecord | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  if (!hasExactKeys(value, ["schemaVersion", "gateToken", "host", "port", "challenge"])) {
    return undefined;
  }
  const schemaVersion = Reflect.get(value, "schemaVersion");
  const gateToken = Reflect.get(value, "gateToken");
  const host = Reflect.get(value, "host");
  const port = Reflect.get(value, "port");
  const challenge = Reflect.get(value, "challenge");
  if (
    schemaVersion !== 1 ||
    typeof gateToken !== "string" ||
    host !== "127.0.0.1" ||
    !isValidPort(port) ||
    typeof challenge !== "string"
  ) {
    return undefined;
  }
  return { schemaVersion, gateToken, host, port, challenge };
}

async function readJson(
  path: string,
): Promise<{ readonly raw: string; readonly value: unknown } | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    return { raw, value: JSON.parse(raw) };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    if (error instanceof SyntaxError) {
      return { raw: "", value: undefined };
    }
    throw error;
  }
}

async function probeOwner(
  record: LeaseOwnerRecord,
  timeoutMilliseconds: number,
): Promise<LeaseProbeResult> {
  const results = await Promise.all(
    record.participants.map((participant) =>
      probeLeaseEndpoint(participant, record.leaseToken, timeoutMilliseconds),
    ),
  );
  if (results.includes("live")) {
    return "live";
  }
  return results.includes("unknown") ? "unknown" : "dead";
}

export class ProjectBusyError extends Error {
  readonly code = "PROJECT_BUSY" as const;

  constructor(projectRoot: string) {
    super(`Project is already in use: ${projectRoot}`);
    this.name = "ProjectBusyError";
  }
}

interface LeasePaths {
  readonly projectRoot: string;
  readonly reforceRoot: string;
  readonly leaseRoot: string;
  readonly quarantineRoot: string;
  readonly readersRoot: string;
  readonly writerRoot: string;
  readonly gateRoot: string;
}

async function prepareLeasePaths(projectRoot: string): Promise<LeasePaths> {
  const canonicalProjectRoot = await realpath(projectRoot);
  const projectStats = await lstat(canonicalProjectRoot);
  if (!projectStats.isDirectory()) {
    throw new Error(`Project root is not a directory: ${projectRoot}`);
  }
  const reforceRoot = join(canonicalProjectRoot, ".reforce");
  await mkdir(reforceRoot, { recursive: true });
  const canonicalReforceRoot = await realpath(reforceRoot);
  assertContained(canonicalProjectRoot, canonicalReforceRoot);
  const leaseRoot = join(canonicalReforceRoot, "lease");
  const quarantineRoot = join(leaseRoot, "quarantine");
  const readersRoot = join(leaseRoot, "readers");
  await mkdir(quarantineRoot, { recursive: true });
  await mkdir(readersRoot, { recursive: true });
  const canonicalLeaseRoot = await realpath(leaseRoot);
  const canonicalQuarantineRoot = await realpath(quarantineRoot);
  const canonicalReadersRoot = await realpath(readersRoot);
  assertContained(canonicalReforceRoot, canonicalLeaseRoot);
  assertContained(canonicalLeaseRoot, canonicalQuarantineRoot);
  assertContained(canonicalLeaseRoot, canonicalReadersRoot);
  return {
    projectRoot: canonicalProjectRoot,
    reforceRoot: canonicalReforceRoot,
    leaseRoot: canonicalLeaseRoot,
    quarantineRoot: canonicalQuarantineRoot,
    readersRoot: canonicalReadersRoot,
    writerRoot: join(canonicalLeaseRoot, "writer"),
    gateRoot: join(canonicalLeaseRoot, "gate"),
  };
}

async function quarantineDirectory(
  paths: LeasePaths,
  source: string,
  label: string,
): Promise<void> {
  const destination = join(paths.quarantineRoot, `${label}-${randomUUID()}`);
  await renameWithWindowsRetry(source, destination);
  await safeRemoveDirectory(destination, paths.quarantineRoot);
}

// 「现在还抢不到 gate」的每条出口都必须走这里：只有预算耗尽才判死，否则退避后回到 while (!ownsGate)
// 重抢。少扣预算就是把正常竞争报成 PROJECT_BUSY，少退避就是让重试循环不受预算约束地忙等（#101）。
async function waitForGateRetry(projectRoot: string, deadline: number): Promise<void> {
  if (Date.now() >= deadline) {
    throw new ProjectBusyError(projectRoot);
  }
  await sleep(10);
}

async function inspectExistingGate(
  paths: LeasePaths,
  probeTimeoutMilliseconds: number,
  deadline: number,
): Promise<void> {
  const gateSnapshot = await readJson(join(paths.gateRoot, "record.json"));
  // gate 目录整体由 rename 发布、由 quarantine 整体搬走，所以「目录在、record.json 不在」只可能是
  // 持有者在我们抢锁失败之后释放了 gate。此刻 gate 空闲，判死就是误报（#101）。
  if (!gateSnapshot) {
    await waitForGateRetry(paths.projectRoot, deadline);
    return;
  }
  const gateRecord = parseGateRecord(gateSnapshot.value);
  if (!gateRecord) {
    throw new ProjectBusyError(paths.projectRoot);
  }
  const status = await probeLeaseEndpoint(
    gateRecord,
    gateRecord.gateToken,
    probeTimeoutMilliseconds,
  );
  // "unknown" 说的是探测没有结论，不是持有者活着；而释放路径关停端点时会 destroy 未完成的连接，
  // 等待方常态会收到 ECONNRESET，所以它只能和 "live" 一样退避重试（#101）。
  if (status === "live" || status === "unknown") {
    await waitForGateRetry(paths.projectRoot, deadline);
    return;
  }
  const current = await readJson(join(paths.gateRoot, "record.json"));
  // Only quarantine when the record is byte-identical to the snapshot taken before probing;
  // a concurrent acquirer may have published a fresh gate in between and must not be removed (TOCTOU).
  if (current?.raw !== gateSnapshot.raw) {
    await waitForGateRetry(paths.projectRoot, deadline);
    return;
  }
  await quarantineDirectory(paths, paths.gateRoot, `gate-${gateRecord.gateToken}`);
}

async function releaseAcquisitionGate(
  paths: LeasePaths,
  gateToken: string,
  staging: string,
  ownsGate: boolean,
): Promise<void> {
  if (!ownsGate) {
    await safeRemoveDirectory(staging, paths.leaseRoot);
    return;
  }
  const current = await readJson(join(paths.gateRoot, "record.json"));
  const currentRecord = parseGateRecord(current?.value);
  if (currentRecord?.gateToken === gateToken) {
    await quarantineDirectory(paths, paths.gateRoot, `gate-${gateToken}`);
  }
}

async function withAcquisitionGate<T>(
  paths: LeasePaths,
  probeTimeoutMilliseconds: number,
  gateWaitMilliseconds: number,
  operation: () => Promise<T>,
): Promise<T> {
  const gateToken = randomToken();
  const endpoint = await LivenessEndpoint.create(gateToken);
  const staging = join(paths.leaseRoot, `.gate-${gateToken}`);
  const deadline = Date.now() + gateWaitMilliseconds;
  await mkdir(staging);
  await writeJsonClosed(join(staging, "record.json"), {
    schemaVersion: 1,
    gateToken,
    host: "127.0.0.1",
    port: endpoint.port,
    challenge: endpoint.challenge,
  } satisfies GateRecord);

  let ownsGate = false;
  try {
    while (!ownsGate) {
      ownsGate = await publishMissingDestinationWithWindowsRetry(staging, paths.gateRoot);
      if (!ownsGate) {
        await inspectExistingGate(paths, probeTimeoutMilliseconds, deadline);
      }
    }

    return await operation();
  } finally {
    await releaseAcquisitionGate(paths, gateToken, staging, ownsGate);
    await endpoint.close();
  }
}

interface OwnerSnapshot {
  readonly directory: string;
  readonly raw: string;
  readonly record: LeaseOwnerRecord;
}

async function readOwner(
  directory: string,
  projectRoot: string,
): Promise<OwnerSnapshot | undefined> {
  const snapshot = await readJson(join(directory, "record.json"));
  if (!snapshot) {
    return undefined;
  }
  const record = parseOwnerRecord(snapshot.value);
  if (!record) {
    throw new ProjectBusyError(projectRoot);
  }
  return { directory, raw: snapshot.raw, record };
}

async function listReaderOwners(paths: LeasePaths): Promise<readonly OwnerSnapshot[]> {
  const entries = await readdir(paths.readersRoot, { withFileTypes: true });
  entries.sort((left, right) => compareUtf16CodeUnits(left.name, right.name));
  const readers: OwnerSnapshot[] = [];
  for (const entry of entries) {
    // readers/ 下只有 lease 自己 rename 进来的 owner 目录；普通文件（Finder 的 .DS_Store、同步盘副本）
    // 不可能是 reader。抛错会让 dev/build 的 writer 抢锁永久失败，而且抛的不是 ProjectBusyError，
    // 会被 reportCommandFailure 报成 BUILD_FAILED，把用户指向自己的构建。缺 record.json 的残缺
    // 目录本来就是跳过语义（readOwner 返回 undefined）。
    if (!entry.isDirectory()) {
      continue;
    }
    const reader = await readOwner(join(paths.readersRoot, entry.name), paths.projectRoot);
    if (reader) {
      readers.push(reader);
    }
  }
  return readers;
}

async function isolateDeadOwner(paths: LeasePaths, snapshot: OwnerSnapshot): Promise<void> {
  const current = await readOwner(snapshot.directory, paths.projectRoot);
  if (!current || current.raw !== snapshot.raw) {
    throw new ProjectBusyError(paths.projectRoot);
  }
  await quarantineDirectory(
    paths,
    snapshot.directory,
    `${snapshot.record.mode}-${snapshot.record.leaseToken}`,
  );
}

async function atomicReplaceOwnerRecord(
  directory: string,
  record: LeaseOwnerRecord,
): Promise<void> {
  const temporaryPath = join(directory, `record-${randomUUID()}.json`);
  await writeJsonClosed(temporaryPath, record);
  await renameWithWindowsRetry(temporaryPath, join(directory, "record.json"));
}

async function conflictingOwners(
  paths: LeasePaths,
  mode: ProjectLeaseMode,
): Promise<{
  readonly writer?: OwnerSnapshot;
  readonly owners: readonly OwnerSnapshot[];
}> {
  const writer = await readOwner(paths.writerRoot, paths.projectRoot);
  const owners: OwnerSnapshot[] = [];
  if (writer) {
    owners.push(writer);
  }
  if (mode === "writer") {
    owners.push(...(await listReaderOwners(paths)));
  }
  return { ...(writer ? { writer } : {}), owners };
}

async function recoverConflictingOwners(
  paths: LeasePaths,
  mode: ProjectLeaseMode,
  conflicts: {
    readonly writer?: OwnerSnapshot;
    readonly owners: readonly OwnerSnapshot[];
  },
  probeTimeoutMilliseconds: number,
): Promise<readonly string[]> {
  // reader 绝不能隔离 writer 记录，哪怕探测判定它已经死了：隔离死 writer 才会产出
  // recoveredWriterTokens，而那是下一个 writer 用 adoptJournal 接管半发布事务的唯一凭据
  // （directory-transaction.ts 的 canRecoverWriterToken）。reader 抢先隔离掉，事务就永远无法 adopt。
  // 因此探测结果对 reader 没有意义，先判死再省下探测。
  if (mode === "reader" && conflicts.writer) {
    throw new ProjectBusyError(paths.projectRoot);
  }
  const statuses = await Promise.all(
    conflicts.owners.map((conflict) => probeOwner(conflict.record, probeTimeoutMilliseconds)),
  );
  if (statuses.some((status) => status !== "dead")) {
    throw new ProjectBusyError(paths.projectRoot);
  }

  const recovered: string[] = [];
  for (const conflict of conflicts.owners) {
    await isolateDeadOwner(paths, conflict);
    if (mode === "writer" && conflict.record.mode === "writer") {
      recovered.push(conflict.record.leaseToken);
    }
  }
  return [...new Set(recovered)].sort(compareUtf16CodeUnits);
}

function ownerDirectory(paths: LeasePaths, mode: ProjectLeaseMode, leaseToken: string): string {
  return mode === "writer" ? paths.writerRoot : join(paths.readersRoot, leaseToken);
}

async function publishOwnerRecord(paths: LeasePaths, record: LeaseOwnerRecord): Promise<void> {
  const staging = join(paths.leaseRoot, `.owner-${record.leaseToken}`);
  const destination = ownerDirectory(paths, record.mode, record.leaseToken);
  await mkdir(staging);
  await writeJsonClosed(join(staging, "record.json"), record);
  await renameWithWindowsRetry(staging, destination);
}

export class ProjectLease {
  readonly mode: ProjectLeaseMode;
  readonly projectRoot: string;
  readonly leaseToken: string;
  readonly recoveredWriterTokens: readonly string[];
  private readonly endpoint: LivenessEndpoint;
  private readonly paths: LeasePaths;
  private readonly probeTimeoutMilliseconds: number;
  private readonly gateWaitMilliseconds: number;
  private readonly recoverableWriterTokens: Set<string>;
  private releasePromise?: Promise<void>;

  private constructor(input: {
    readonly mode: ProjectLeaseMode;
    readonly paths: LeasePaths;
    readonly leaseToken: string;
    readonly endpoint: LivenessEndpoint;
    readonly recoveredWriterTokens: readonly string[];
    readonly probeTimeoutMilliseconds: number;
    readonly gateWaitMilliseconds: number;
  }) {
    this.mode = input.mode;
    this.projectRoot = input.paths.projectRoot;
    this.leaseToken = input.leaseToken;
    this.paths = input.paths;
    this.endpoint = input.endpoint;
    this.recoveredWriterTokens = Object.freeze([...input.recoveredWriterTokens]);
    this.recoverableWriterTokens = new Set(input.recoveredWriterTokens);
    this.probeTimeoutMilliseconds = input.probeTimeoutMilliseconds;
    this.gateWaitMilliseconds = input.gateWaitMilliseconds;
  }

  static async acquire(options: AcquireProjectLeaseOptions): Promise<ProjectLease> {
    const probeTimeoutMilliseconds = options.probeTimeoutMilliseconds ?? 500;
    const gateWaitMilliseconds = options.gateWaitMilliseconds ?? 5_000;
    const paths = await prepareLeasePaths(options.projectRoot);
    const leaseToken = randomToken();
    const endpoint = await LivenessEndpoint.create(leaseToken);
    const ownRecord: LeaseOwnerRecord = {
      schemaVersion: 1,
      mode: options.mode,
      leaseToken,
      participants: [endpoint.participant("parent")],
      pid: process.pid,
    };

    try {
      const recoveredWriterTokens = await withAcquisitionGate(
        paths,
        probeTimeoutMilliseconds,
        gateWaitMilliseconds,
        async () => {
          const recovered = await recoverConflictingOwners(
            paths,
            options.mode,
            await conflictingOwners(paths, options.mode),
            probeTimeoutMilliseconds,
          );
          await publishOwnerRecord(paths, ownRecord);
          return recovered;
        },
      );

      return new ProjectLease({
        mode: options.mode,
        paths,
        leaseToken,
        endpoint,
        recoveredWriterTokens,
        probeTimeoutMilliseconds,
        gateWaitMilliseconds,
      });
    } catch (error) {
      await endpoint.close();
      throw error;
    }
  }

  async addParticipant(participant: LeaseParticipant): Promise<void> {
    const validatedParticipant = parseParticipant(participant);
    if (validatedParticipant?.role !== "child") {
      throw new ProjectBusyError(this.projectRoot);
    }
    const status = await probeLeaseEndpoint(
      validatedParticipant,
      this.leaseToken,
      this.probeTimeoutMilliseconds,
    );
    if (status !== "live") {
      throw new ProjectBusyError(this.projectRoot);
    }
    await this.updateParticipants((participants) => {
      if (
        participants.some(
          (candidate) => candidate.participantToken === validatedParticipant.participantToken,
        )
      ) {
        return participants;
      }
      return [...participants, validatedParticipant];
    });
  }

  async removeParticipant(participantToken: string): Promise<void> {
    if (participantToken === this.endpoint.participantToken) {
      throw new Error("The parent participant remains registered for the lease lifetime.");
    }
    await this.updateParticipants((participants) =>
      participants.filter((participant) => participant.participantToken !== participantToken),
    );
  }

  async assertCurrentWriter(): Promise<void> {
    if (this.mode !== "writer") {
      throw new Error("A reader lease cannot publish a transaction.");
    }
    const current = await readOwner(this.paths.writerRoot, this.projectRoot);
    if (current?.record.leaseToken !== this.leaseToken) {
      throw new ProjectBusyError(this.projectRoot);
    }
  }

  canRecoverWriterToken(token: string): boolean {
    return this.recoverableWriterTokens.has(token);
  }

  consumeRecoveredWriterToken(token: string): void {
    if (!this.recoverableWriterTokens.delete(token)) {
      throw new ProjectBusyError(this.projectRoot);
    }
  }

  release(): Promise<void> {
    // memo 只用于合并 in-flight 的并发调用，不记录终态：释放失败是瞬时的（child participant 还在收尾、
    // gate 竞争），owner 记录仍在盘上，之后的调用必须重跑而不是重放这次 rejection。`??=` 的赋值在
    // rejection handler 之前同步完成，所以并发调用仍然拿到同一个 promise。重试时 endpoint.close()
    // 是 no-op（LivenessEndpoint 自身也 memo 已 resolve 的 close）。
    this.releasePromise ??= this.performRelease().catch((error: unknown) => {
      this.releasePromise = undefined;
      throw error;
    });
    return this.releasePromise;
  }

  private async performRelease(): Promise<void> {
    await this.endpoint.close();
    await withAcquisitionGate(
      this.paths,
      this.probeTimeoutMilliseconds,
      this.gateWaitMilliseconds,
      async () => {
        const directory = ownerDirectory(this.paths, this.mode, this.leaseToken);
        const current = await readOwner(directory, this.projectRoot);
        if (current?.record.leaseToken === this.leaseToken) {
          const childParticipants = current.record.participants.filter(
            (participant) => participant.participantToken !== this.endpoint.participantToken,
          );
          const childStatuses = await Promise.all(
            childParticipants.map((participant) =>
              probeLeaseEndpoint(participant, this.leaseToken, this.probeTimeoutMilliseconds),
            ),
          );
          if (childStatuses.some((status) => status !== "dead")) {
            throw new ProjectBusyError(this.projectRoot);
          }
          await quarantineDirectory(this.paths, directory, `${this.mode}-${this.leaseToken}`);
        }
      },
    );
  }

  private async updateParticipants(
    update: (participants: readonly LeaseParticipant[]) => readonly LeaseParticipant[],
  ): Promise<void> {
    await withAcquisitionGate(
      this.paths,
      this.probeTimeoutMilliseconds,
      this.gateWaitMilliseconds,
      async () => {
        const directory = ownerDirectory(this.paths, this.mode, this.leaseToken);
        const current = await readOwner(directory, this.projectRoot);
        if (current?.record.leaseToken !== this.leaseToken) {
          throw new ProjectBusyError(this.projectRoot);
        }
        const participants = update(current.record.participants);
        if (participants.length === 0) {
          throw new Error("A live lease must retain at least one participant.");
        }
        await atomicReplaceOwnerRecord(directory, {
          ...current.record,
          participants,
        });
      },
    );
  }
}
