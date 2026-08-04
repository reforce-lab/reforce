import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  symlink,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GeneratedFile } from "@reforce/compiler";
import {
  createTemporaryProject,
  readProjectTree,
  type TemporaryProject,
  testStallBudgetMilliseconds,
} from "@reforce/tooling-testing";
import {
  DirectoryTransactionError,
  DirectoryTransactions,
  snapshotTree,
} from "@/project/directory-transaction";
import { errorCode, isMissingPathError } from "@/project/fs-error";
import { ProjectBusyError, ProjectLease } from "@/project/lease";
import {
  type BunIpcHarness,
  type IpcProcessOutcome,
  spawnBunIpcHarness,
} from "../support/process/bun-ipc-harness";

const leases: ProjectLease[] = [];
const projects: TemporaryProject[] = [];

afterEach(async () => {
  for (const lease of leases.splice(0).reverse()) {
    await lease.release();
  }
  for (const project of projects.splice(0).reverse()) {
    await project.cleanup();
  }
});

async function setupWriter() {
  const project = await createTemporaryProject();
  projects.push(project);
  const lease = await ProjectLease.acquire({ projectRoot: project.projectRoot, mode: "writer" });
  leases.push(lease);
  const transactions = await DirectoryTransactions.create({
    projectRoot: project.projectRoot,
    lease,
  });
  return { project, lease, transactions };
}

function generatedFiles(generation: string): readonly GeneratedFile[] {
  return [
    { path: "beans.ts", content: `export const generation = ${JSON.stringify(generation)};\n` },
    { path: "bootstrap.ts", content: "export async function bootstrap() {}\n" },
    {
      path: "manifest.json",
      content: `${JSON.stringify({
        schemaVersion: 4,
        configs: [],
        beans: [],
        plans: {
          constructionOrder: [],
          requestConstructionOrder: [],
          startActionOrder: [],
          cleanupActionOrder: [],
        },
      })}\n`,
    },
    { path: "qualifiers.d.ts", content: "export {};\n" },
    {
      path: "routes.json",
      content: `${JSON.stringify({ schemaVersion: 1, routes: [], errorHandlers: [] })}\n`,
    },
    {
      path: "routes.ts",
      content:
        "export const routeTable = {\n  schemaVersion: 1,\n  routes: [],\n  errorHandlers: [],\n} as const;\n",
    },
  ];
}

const resourceId = "src/resource.ts#resource";
const consumerId = "src/consumer.ts#Consumer";

function sourceReference(file: string) {
  return {
    file,
    start: { offset: 0, line: 0, character: 0 },
    end: { offset: 1, line: 0, character: 1 },
  };
}

function symbolReference(file: string, exportName: string) {
  return {
    displayName: exportName,
    moduleSpecifier: `../../${file.replace(/\.[cm]?tsx?$/u, ".js")}`,
    exportName,
    declaration: sourceReference(file),
  };
}

function manifestDependency(targetId = resourceId) {
  return {
    parameterIndex: 0,
    targetId,
    mode: "eager",
    source: sourceReference("src/consumer.ts"),
  };
}

function resourceManifestBean() {
  return {
    id: resourceId,
    kind: "factory",
    source: sourceReference("src/resource.ts"),
    runtimeExport: {
      moduleSpecifier: "../../src/resource.js",
      exportName: "resource",
    },
    provides: [symbolReference("src/resource.ts", "Resource")],
    dependencies: [],
    primary: false,
    qualifiers: [],
    lifecycle: { start: false, close: false, dispose: true },
  };
}

function consumerManifestBean() {
  return {
    id: consumerId,
    kind: "class",
    source: sourceReference("src/consumer.ts"),
    runtimeExport: {
      moduleSpecifier: "../../src/consumer.js",
      exportName: "Consumer",
    },
    provides: [symbolReference("src/consumer.ts", "Consumer")],
    dependencies: [manifestDependency()],
    primary: false,
    qualifiers: [],
    lifecycle: { start: true, close: true, dispose: false },
  };
}

interface ManifestPlans {
  readonly constructionOrder: readonly string[];
  readonly startActionOrder: readonly string[];
  readonly cleanupActionOrder: readonly string[];
}

function manifestPlans(overrides: Partial<ManifestPlans> = {}): ManifestPlans {
  return {
    constructionOrder: overrides.constructionOrder ?? [resourceId, consumerId],
    startActionOrder: overrides.startActionOrder ?? [consumerId],
    cleanupActionOrder: overrides.cleanupActionOrder ?? [consumerId, resourceId],
  };
}

function generatedManifest(
  input: { readonly beans?: readonly object[]; readonly plans?: ManifestPlans } = {},
) {
  return {
    schemaVersion: 4,
    configs: [],
    beans: input.beans ?? [resourceManifestBean(), consumerManifestBean()],
    plans: input.plans ?? manifestPlans(),
  };
}

function generatedFilesWithManifest(
  generation: string,
  manifest: unknown,
): readonly GeneratedFile[] {
  return generatedFiles(generation).map((file) =>
    file.path === "manifest.json" ? { ...file, content: `${JSON.stringify(manifest)}\n` } : file,
  );
}

async function replaceJournalSnapshot(journalPath: string, treeRoot: string): Promise<void> {
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  await writeFile(
    journalPath,
    `${JSON.stringify({ ...journal, ...(await snapshotTree(treeRoot)) }, undefined, 2)}\n`,
  );
}

async function activeGeneration(projectRoot: string): Promise<string> {
  const source = await readFile(join(projectRoot, ".reforce", "generated", "beans.ts"), "utf8");
  const prefix = "export const generation = ";
  if (!source.startsWith(prefix) || !source.endsWith(";\n")) {
    throw new Error("Expected a generation marker.");
  }
  const generation = JSON.parse(source.slice(prefix.length, -2));
  if (typeof generation !== "string") {
    throw new Error("Expected a string generation marker.");
  }
  return generation;
}

async function commitDistGeneration(
  transactions: DirectoryTransactions,
  generation: string,
): Promise<void> {
  const prepared = await transactions.prepareDist();
  await mkdir(join(prepared.stagingDirectory, "chunks"));
  await writeFile(
    join(prepared.stagingDirectory, "main.mjs"),
    `await import("./chunks/${generation}.mjs");\n`,
  );
  await writeFile(join(prepared.stagingDirectory, "chunks", `${generation}.mjs`), "export {};\n");
  await transactions.commitDist({
    ...prepared,
    expectedFiles: [`chunks/${generation}.mjs`, "main.mjs"],
  });
}

async function activeDistGeneration(projectRoot: string): Promise<string> {
  const source = await readFile(join(projectRoot, "dist", "main.mjs"), "utf8");
  const match = /^await import\("\.\/chunks\/(.+)\.mjs"\);\n$/.exec(source);
  const generation = match?.[1];
  if (!generation) {
    throw new Error("Expected a dist generation marker.");
  }
  return generation;
}

// 注入过 chmod 000 的文件要在断言前恢复可读，否则读取它的断言自己先失败。容忍 ENOENT：
// 事务如果把这棵树删掉了（正是 Issue #105 要证伪的回滚），恢复目标就不再存在。
async function restoreReadableIfPresent(path: string): Promise<void> {
  try {
    await chmod(path, 0o644);
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
  }
}

// 每条用例的击杀钟统一由包级 `bun test --timeout` 提供，spec 里不再各自声明（Issue #92）；
// 这里只保留 harness 退出这一个内层诊断钟——它先于外层触发，把「泛泛的用例超时」换成
// 「harness 没退出」的现场信息。预算沿用共享停滞常量：抓「卡死」不是管「慢」（Issue #75、#81）。
async function waitForHarnessExit(
  harness: BunIpcHarness,
  timeoutMessage: string,
): Promise<IpcProcessOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), testStallBudgetMilliseconds);
    timer.unref();
  });
  try {
    return await Promise.race([harness.wait(), timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function detachHarness(harness: BunIpcHarness): readonly unknown[] {
  const errors: unknown[] = [];
  try {
    if (harness.child.connected) {
      harness.child.disconnect();
    }
  } catch (error) {
    errors.push(error);
  }
  try {
    harness.child.unref();
  } catch (error) {
    errors.push(error);
  }
  try {
    harness.child.stdout?.destroy();
  } catch (error) {
    errors.push(error);
  }
  try {
    harness.child.stderr?.destroy();
  } catch (error) {
    errors.push(error);
  }
  return errors;
}

function parseReadyLeaseToken(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null || Reflect.get(message, "type") !== "ready") {
    return undefined;
  }
  const leaseToken = Reflect.get(message, "leaseToken");
  return typeof leaseToken === "string" ? leaseToken : undefined;
}

function assertTransactionCrashOutcome(
  holder: BunIpcHarness,
  result: IpcProcessOutcome,
  fault: { readonly faultPoint: string } | { readonly faultIndex: number },
  transactionKind: "generated" | "dist",
  expectedPoint?: string,
): void {
  if (result.exitCode === 87) {
    return;
  }
  const output = holder.output();
  const faultIndex = "faultIndex" in fault ? String(fault.faultIndex) : "none";
  const point = "faultPoint" in fault ? fault.faultPoint : (expectedPoint ?? "unknown");
  throw new Error(
    [
      `Transaction holder did not crash as requested: kind=${transactionKind}, faultIndex=${faultIndex}, point=${point}.`,
      `exitCode=${result.exitCode ?? "null"}, signal=${result.signal ?? "none"}.`,
      `stdout:\n${output.stdout}`,
      `stderr:\n${output.stderr}`,
    ].join("\n"),
  );
}

async function cleanupTransactionHolder(holder: BunIpcHarness): Promise<void> {
  const errors: unknown[] = [];
  try {
    if (holder.child.exitCode === null && holder.child.signalCode === null) {
      holder.child.kill();
    }
  } catch (error) {
    errors.push(error);
  }
  try {
    await waitForHarnessExit(holder, "Transaction holder did not exit during cleanup.");
  } catch (error) {
    errors.push(error, ...detachHarness(holder));
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "Transaction crash harness cleanup failed.", {
      cause: errors[0],
    });
  }
}

async function spawnTransactionCrash(
  projectRoot: string,
  fault: { readonly faultPoint: string } | { readonly faultIndex: number },
  transactionKind: "generated" | "dist" = "generated",
  expectedPoint?: string,
): Promise<string> {
  const harnessPath = fileURLToPath(
    new URL("../support/process/lease/project-lease.harness.ts", import.meta.url),
  );
  const holder = spawnBunIpcHarness(harnessPath, [projectRoot, "writer"]);
  try {
    const message = await holder.waitForMessage("Transaction holder did not publish readiness.");
    const leaseToken = parseReadyLeaseToken(message);
    if (leaseToken === undefined) {
      throw new Error("Transaction holder sent an invalid ready message.");
    }
    await holder.sendMessage({ type: "transaction-crash", transactionKind, ...fault });
    const result = await waitForHarnessExit(
      holder,
      "Transaction holder did not exit after the requested crash.",
    );
    assertTransactionCrashOutcome(holder, result, fault, transactionKind, expectedPoint);
    return leaseToken;
  } catch (error) {
    try {
      await cleanupTransactionHolder(holder);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Transaction crash harness failed.", {
        cause: error,
      });
    }
    throw error;
  }
}

function shuffledIndexes(length: number): readonly number[] {
  const indexes = Array.from({ length }, (_, index) => index);
  let state = 0x5f37_59df;
  for (let index = indexes.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const swapIndex = state % (index + 1);
    const current = indexes[index];
    indexes[index] = indexes[swapIndex] ?? index;
    indexes[swapIndex] = current ?? swapIndex;
  }
  return indexes;
}

async function observeGeneratedFaultPoints(): Promise<readonly string[]> {
  const baseline = await setupWriter();
  try {
    await baseline.transactions.commitGenerated(generatedFiles("pre"));
    const observedPoints: string[] = [];
    const traced = await DirectoryTransactions.create({
      projectRoot: baseline.project.projectRoot,
      lease: baseline.lease,
      faultInjector(point, context) {
        observedPoints.push(`${point}:${context.path ?? ""}`);
      },
    });

    await traced.commitGenerated(generatedFiles("post"));

    expect(observedPoints.length).toBeGreaterThan(40);
    return observedPoints;
  } finally {
    await baseline.lease.release();
    leases.splice(leases.indexOf(baseline.lease), 1);
    await baseline.project.cleanup();
    projects.splice(projects.indexOf(baseline.project), 1);
  }
}

async function verifyGeneratedCrashBoundaryHalf(half: "first" | "second"): Promise<void> {
  const observedPoints = await observeGeneratedFaultPoints();
  const indexes = shuffledIndexes(observedPoints.length);
  const midpoint = Math.ceil(indexes.length / 2);
  const selectedIndexes = half === "first" ? indexes.slice(0, midpoint) : indexes.slice(midpoint);

  for (const faultIndex of selectedIndexes) {
    const project = await createTemporaryProject();
    let initialLease: ProjectLease | undefined;
    let replacement: ProjectLease | undefined;
    try {
      initialLease = await ProjectLease.acquire({
        projectRoot: project.projectRoot,
        mode: "writer",
      });
      const initialTransactions = await DirectoryTransactions.create({
        projectRoot: project.projectRoot,
        lease: initialLease,
      });
      await initialTransactions.commitGenerated(generatedFiles("pre"));
      await initialLease.release();
      initialLease = undefined;

      const crashedWriterToken = await spawnTransactionCrash(
        project.projectRoot,
        { faultIndex },
        "generated",
        observedPoints[faultIndex],
      );
      replacement = await ProjectLease.acquire({
        projectRoot: project.projectRoot,
        mode: "writer",
      });
      expect(replacement.recoveredWriterTokens).toEqual([crashedWriterToken]);
      const recovery = await DirectoryTransactions.create({
        projectRoot: project.projectRoot,
        lease: replacement,
      });
      await recovery.recover();

      expect(["pre", "post"]).toContain(await activeGeneration(project.projectRoot));
      const generatedTransactions = await readdir(
        join(project.projectRoot, ".reforce", "transactions", "generated"),
      );
      expect(generatedTransactions).toEqual([]);
      const reforceEntries = await readdir(join(project.projectRoot, ".reforce"));
      const transactionLeftovers = reforceEntries.filter(
        (entry) => entry.startsWith("generated.staging-") || entry.startsWith("generated.backup-"),
      );
      if (transactionLeftovers.length > 0) {
        throw new Error(
          `Crash boundary ${faultIndex} (${observedPoints[faultIndex]}) left ${transactionLeftovers.join(", ")}.`,
        );
      }
    } finally {
      await initialLease?.release();
      await replacement?.release();
      await project.cleanup();
    }
  }
}

describe("directory transactions", () => {
  test("rejects transaction metadata that resolves outside the project", async () => {
    const project = await createTemporaryProject();
    const external = await createTemporaryProject();
    projects.push(project, external);
    const lease = await ProjectLease.acquire({
      projectRoot: project.projectRoot,
      mode: "writer",
    });
    leases.push(lease);
    await symlink(
      external.projectRoot,
      join(project.projectRoot, ".reforce", "transactions"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const creation = DirectoryTransactions.create({
      projectRoot: project.projectRoot,
      lease,
    });

    await expect(creation).rejects.toThrow("outside its required boundary");
  });

  // commitDist derives every path from the caller-supplied token, so a leftover
  // `dist.staging-<token>` symlink pointing at the project root reaches removeTree with a target
  // that canonicalizes to removeTree's own boundary. The containment check must keep treating
  // "target equals boundary" as an escape: it is the only thing standing between this state and
  // removeDirectoryContents wiping the user's project root (#55).
  test("refuses to clean a dist staging path that resolves to the project root", async () => {
    const { project, lease, transactions } = await setupWriter();
    const stagingDirectory = join(lease.projectRoot, "dist.staging-equalboundary");
    await symlink(
      lease.projectRoot,
      stagingDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );

    const commit = transactions.commitDist({
      transactionToken: "equalboundary",
      stagingDirectory,
      expectedFiles: ["main.mjs"],
    });

    await expect(commit).rejects.toThrow("outside its required boundary");
    expect(await readdir(project.projectRoot)).toContain(".reforce");
  });

  test("publishes an exact generated tree and removes the previous generation", async () => {
    const { project, transactions } = await setupWriter();
    await transactions.commitGenerated(generatedFiles("pre"));

    await transactions.commitGenerated(generatedFiles("post"));

    expect(await activeGeneration(project.projectRoot)).toBe("post");
    expect(
      (await readProjectTree(join(project.projectRoot, ".reforce", "generated"))).map(
        (entry) => entry.path,
      ),
    ).toEqual([
      "beans.ts",
      "bootstrap.ts",
      "manifest.json",
      "qualifiers.d.ts",
      "routes.json",
      "routes.ts",
    ]);
  });

  test("rejects an incomplete generated file set before publishing", async () => {
    const { project, transactions } = await setupWriter();
    const incomplete = generatedFiles("post").slice(1);

    const commit = transactions.commitGenerated(incomplete);

    await expect(commit).rejects.toBeInstanceOf(DirectoryTransactionError);
    await expect(
      readFile(join(project.projectRoot, ".reforce", "generated", "manifest.json"), "utf8"),
    ).rejects.toHaveProperty("code", "ENOENT");
  });

  test("preserves the active generation when a new manifest has an unknown field", async () => {
    const { project, transactions } = await setupWriter();
    await transactions.commitGenerated(generatedFiles("pre"));
    const invalidFiles = generatedFiles("post").map((file) =>
      file.path === "manifest.json"
        ? {
            ...file,
            content: `${JSON.stringify({
              schemaVersion: 4,
              configs: [],
              beans: [],
              plans: {
                constructionOrder: [],
                requestConstructionOrder: [],
                startActionOrder: [],
                cleanupActionOrder: [],
              },
              unexpected: true,
            })}\n`,
          }
        : file,
    );

    const commit = transactions.commitGenerated(invalidFiles);

    await expect(commit).rejects.toBeInstanceOf(DirectoryTransactionError);
    expect(await activeGeneration(project.projectRoot)).toBe("pre");
  });

  const malformedManifestCases: readonly {
    readonly behavior: string;
    readonly create: () => unknown;
  }[] = [
    {
      behavior: "a Bean ID has a noncanonical file part",
      create() {
        const id = "../resource.ts#resource";
        return generatedManifest({
          beans: [
            { ...resourceManifestBean(), id },
            {
              ...consumerManifestBean(),
              dependencies: [manifestDependency(id)],
            },
          ],
          plans: manifestPlans({
            constructionOrder: [id, consumerId],
            cleanupActionOrder: [consumerId, id],
          }),
        });
      },
    },
    {
      behavior: "a source span ends before it starts",
      create() {
        const source = sourceReference("src/resource.ts");
        return generatedManifest({
          beans: [
            {
              ...resourceManifestBean(),
              source: {
                ...source,
                start: { offset: 1, line: 0, character: 1 },
                end: { offset: 0, line: 0, character: 0 },
              },
            },
            consumerManifestBean(),
          ],
        });
      },
    },
    {
      behavior: "a factory declares a dependency",
      create: () =>
        generatedManifest({
          beans: [
            {
              ...resourceManifestBean(),
              dependencies: [{ ...manifestDependency(consumerId), mode: "explicit-lazy" }],
            },
            consumerManifestBean(),
          ],
        }),
    },
    {
      behavior: "a class declares a disposer",
      create: () =>
        generatedManifest({
          beans: [
            resourceManifestBean(),
            {
              ...consumerManifestBean(),
              lifecycle: { start: true, close: true, dispose: true },
            },
          ],
        }),
    },
    {
      behavior: "a factory declares a start action",
      create: () =>
        generatedManifest({
          beans: [
            {
              ...resourceManifestBean(),
              lifecycle: { start: true, close: false, dispose: true },
            },
            consumerManifestBean(),
          ],
          plans: manifestPlans({ startActionOrder: [resourceId, consumerId] }),
        }),
    },
    {
      behavior: "Bean IDs have a portable case collision",
      create() {
        const upperId = "SRC/RESOURCE.TS#RESOURCE";
        const upperFactory = {
          ...resourceManifestBean(),
          id: upperId,
          source: sourceReference("SRC/RESOURCE.TS"),
          runtimeExport: {
            moduleSpecifier: "../../SRC/RESOURCE.js",
            exportName: "RESOURCE",
          },
        };
        return generatedManifest({
          beans: [resourceManifestBean(), upperFactory, consumerManifestBean()],
          plans: manifestPlans({
            constructionOrder: [resourceId, upperId, consumerId],
            cleanupActionOrder: [consumerId, upperId, resourceId],
          }),
        });
      },
    },
    {
      behavior: "a dependency targets an unknown Bean",
      create: () =>
        generatedManifest({
          beans: [
            resourceManifestBean(),
            {
              ...consumerManifestBean(),
              dependencies: [manifestDependency("src/missing.ts#Missing")],
            },
          ],
        }),
    },
    {
      behavior: "a dependency parameter index differs from its array index",
      create: () =>
        generatedManifest({
          beans: [
            resourceManifestBean(),
            {
              ...consumerManifestBean(),
              dependencies: [{ ...manifestDependency(), parameterIndex: 1 }],
            },
          ],
        }),
    },
    {
      behavior: "construction order omits a Bean",
      create: () =>
        generatedManifest({
          plans: manifestPlans({ constructionOrder: [resourceId] }),
        }),
    },
    {
      behavior: "construction order places an eager consumer before its dependency",
      create: () =>
        generatedManifest({
          plans: manifestPlans({ constructionOrder: [consumerId, resourceId] }),
        }),
    },
    {
      behavior: "a lifecycle plan references an unknown Bean",
      create: () =>
        generatedManifest({
          plans: manifestPlans({
            startActionOrder: [consumerId, "src/missing.ts#Missing"],
          }),
        }),
    },
    {
      behavior: "a lifecycle plan repeats a Bean",
      create: () =>
        generatedManifest({
          plans: manifestPlans({
            cleanupActionOrder: [consumerId, resourceId, resourceId],
          }),
        }),
    },
    {
      behavior: "start actions do not cover every start hook",
      create: () => generatedManifest({ plans: manifestPlans({ startActionOrder: [] }) }),
    },
    {
      behavior: "cleanup actions do not cover every cleanup hook",
      create: () =>
        generatedManifest({
          plans: manifestPlans({ cleanupActionOrder: [consumerId] }),
        }),
    },
    {
      behavior: "a generated relative runtime specifier keeps a TypeScript extension",
      create: () =>
        generatedManifest({
          beans: [
            {
              ...resourceManifestBean(),
              runtimeExport: {
                moduleSpecifier: "../../src/resource.ts",
                exportName: "resource",
              },
            },
            consumerManifestBean(),
          ],
        }),
    },
  ];

  for (const scenario of malformedManifestCases) {
    test(`preserves the active generation when ${scenario.behavior}`, async () => {
      const { project, transactions } = await setupWriter();
      await transactions.commitGenerated(generatedFiles("pre"));

      const commit = transactions.commitGenerated(
        generatedFilesWithManifest("post", scenario.create()),
      );

      await expect(commit).rejects.toBeInstanceOf(DirectoryTransactionError);
      expect(await activeGeneration(project.projectRoot)).toBe("pre");
    });
  }

  test("publishes a complete dist tree with dynamic chunks", async () => {
    const { project, transactions } = await setupWriter();
    const prepared = await transactions.prepareDist();
    await mkdir(join(prepared.stagingDirectory, "chunks"));
    await writeFile(
      join(prepared.stagingDirectory, "main.mjs"),
      "await import('./chunks/value.mjs');\n",
    );
    await writeFile(
      join(prepared.stagingDirectory, "chunks", "value.mjs"),
      "export const value = 1;\n",
    );

    await transactions.commitDist({
      ...prepared,
      expectedFiles: ["chunks/value.mjs", "main.mjs"],
    });

    expect(
      (await readProjectTree(join(project.projectRoot, "dist"))).map((entry) => entry.path),
    ).toEqual(["chunks/value.mjs", "main.mjs"]);
  });

  test("preserves a healthy dist when a new artifact tree is incomplete", async () => {
    const { project, transactions } = await setupWriter();
    const healthy = await transactions.prepareDist();
    await writeFile(
      join(healthy.stagingDirectory, "main.mjs"),
      "export const generation = 'pre';\n",
    );
    await transactions.commitDist({ ...healthy, expectedFiles: ["main.mjs"] });
    const incomplete = await transactions.prepareDist();
    await writeFile(
      join(incomplete.stagingDirectory, "main.mjs"),
      "export const generation = 'post';\n",
    );

    const commit = transactions.commitDist({
      ...incomplete,
      expectedFiles: ["chunks/missing.mjs", "main.mjs"],
    });

    await expect(commit).rejects.toBeInstanceOf(DirectoryTransactionError);
    expect(await readFile(join(project.projectRoot, "dist", "main.mjs"), "utf8")).toContain("pre");
  });

  test("rejects a dist file path that is not a relative POSIX path", async () => {
    const { transactions } = await setupWriter();
    const prepared = await transactions.prepareDist();
    await writeFile(join(prepared.stagingDirectory, "main.mjs"), "export {};\n");

    const commit = transactions.commitDist({
      ...prepared,
      expectedFiles: ["../escape.mjs", "main.mjs"],
    });

    await expect(commit).rejects.toBeInstanceOf(DirectoryTransactionError);
  });

  test("classifies a cleanup boundary escape as a dist transaction failure", async () => {
    const { lease, transactions } = await setupWriter();
    const stagingDirectory = join(lease.projectRoot, "dist.staging-classifyboundary");
    await symlink(
      lease.projectRoot,
      stagingDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );

    const commit = transactions.commitDist({
      transactionToken: "classifyboundary",
      stagingDirectory,
      expectedFiles: ["main.mjs"],
    });

    await expect(commit).rejects.toBeInstanceOf(DirectoryTransactionError);
  });

  test("rejects a truncated journal as a journal verification failure", async () => {
    const { project, lease } = await setupWriter();
    const faulty = await DirectoryTransactions.create({
      projectRoot: project.projectRoot,
      lease,
      async faultInjector(point, context) {
        if (point === "before:journal-verification-read" && context.path !== undefined) {
          await truncate(context.path, 12);
        }
      },
    });

    const commit = faulty.commitGenerated(generatedFiles("pre"));

    await expect(commit).rejects.toThrow("Transaction journal verification failed.");
  });

  // chmod 000 在 Windows 上不阻止读取，故障注入不会生效。
  const describeUnreadableTree = process.platform === "win32" ? describe.skip : describe;

  describeUnreadableTree("when the post-publish verification read hits EACCES", () => {
    async function publishOverUnreadableActive() {
      const { project, lease, transactions } = await setupWriter();
      await commitDistGeneration(transactions, "pre");
      const activeMain = join(project.projectRoot, "dist", "main.mjs");
      const faulty = await DirectoryTransactions.create({
        projectRoot: project.projectRoot,
        lease,
        async faultInjector(point) {
          if (point === "before:verification-read") {
            await chmod(activeMain, 0o000);
          }
        },
      });

      const caught = await commitDistGeneration(faulty, "post").then(
        () => undefined,
        (error: unknown) => error,
      );

      await restoreReadableIfPresent(activeMain);
      return { project, caught };
    }

    test("surfaces the underlying errno instead of a journal mismatch", async () => {
      const { caught } = await publishOverUnreadableActive();

      expect(errorCode(caught)).toBe("EACCES");
    });

    test("keeps the published generation instead of rolling it back", async () => {
      const { project } = await publishOverUnreadableActive();

      expect(await activeDistGeneration(project.projectRoot)).toBe("post");
    });
  });

  test("keeps the previous generated tree when a swap stops after backup publication", async () => {
    const { project, lease, transactions } = await setupWriter();
    await transactions.commitGenerated(generatedFiles("pre"));
    const faulty = await DirectoryTransactions.create({
      projectRoot: project.projectRoot,
      lease,
      faultInjector(point) {
        if (point === "after:active-to-backup-rename") {
          throw new Error("injected");
        }
      },
    });

    await expect(faulty.commitGenerated(generatedFiles("post"))).rejects.toMatchObject({
      code: "GENERATED_TRANSACTION_FAILED",
      cause: expect.objectContaining({ message: "injected" }),
    });

    expect(await activeGeneration(project.projectRoot)).toBe("pre");
  });

  test("keeps the new generated tree when a swap stops after active publication", async () => {
    const { project, lease, transactions } = await setupWriter();
    await transactions.commitGenerated(generatedFiles("pre"));
    const faulty = await DirectoryTransactions.create({
      projectRoot: project.projectRoot,
      lease,
      faultInjector(point) {
        if (point === "after:staging-to-active-rename") {
          throw new Error("injected");
        }
      },
    });

    await expect(faulty.commitGenerated(generatedFiles("post"))).rejects.toMatchObject({
      code: "GENERATED_TRANSACTION_FAILED",
      cause: expect.objectContaining({ message: "injected" }),
    });

    expect(await activeGeneration(project.projectRoot)).toBe("post");
  });

  test("recovers a crashed transaction only with the recovered writer token", async () => {
    const { project, lease, transactions } = await setupWriter();
    await transactions.commitGenerated(generatedFiles("pre"));
    await lease.release();
    leases.splice(leases.indexOf(lease), 1);
    const crashedWriterToken = await spawnTransactionCrash(project.projectRoot, {
      faultPoint: "after:active-to-backup-rename",
    });

    const replacement = await ProjectLease.acquire({
      projectRoot: project.projectRoot,
      mode: "writer",
    });
    leases.push(replacement);
    expect(replacement.recoveredWriterTokens).toEqual([crashedWriterToken]);
    const recovery = await DirectoryTransactions.create({
      projectRoot: project.projectRoot,
      lease: replacement,
    });
    await recovery.recover();

    expect(await activeGeneration(project.projectRoot)).toBe("pre");
  });

  test("rejects a hash-matching recovery candidate with a malformed manifest", async () => {
    const project = await createTemporaryProject();
    projects.push(project);
    const crashedWriterToken = await spawnTransactionCrash(project.projectRoot, {
      faultPoint: "after:staging-to-active-rename",
    });
    const generatedRoot = join(project.projectRoot, ".reforce", "generated");
    await writeFile(
      join(generatedRoot, "manifest.json"),
      `${JSON.stringify(
        generatedManifest({
          beans: [
            {
              ...resourceManifestBean(),
              dependencies: [{ ...manifestDependency(consumerId), mode: "explicit-lazy" }],
            },
            consumerManifestBean(),
          ],
        }),
      )}\n`,
    );
    const journalRoot = join(project.projectRoot, ".reforce", "transactions", "generated");
    const transactionToken = (await readdir(journalRoot))[0];
    if (transactionToken === undefined) {
      throw new Error("Expected transaction metadata after the injected crash.");
    }
    await replaceJournalSnapshot(
      join(journalRoot, transactionToken, "journal.json"),
      generatedRoot,
    );
    const replacement = await ProjectLease.acquire({
      projectRoot: project.projectRoot,
      mode: "writer",
    });
    leases.push(replacement);
    expect(replacement.recoveredWriterTokens).toEqual([crashedWriterToken]);
    const recovery = await DirectoryTransactions.create({
      projectRoot: project.projectRoot,
      lease: replacement,
    });

    await expect(recovery.recover()).rejects.toBeInstanceOf(DirectoryTransactionError);
  });

  test("refuses recovery when a journal token was not proven dead by acquisition", async () => {
    const { project, lease, transactions } = await setupWriter();
    await transactions.commitGenerated(generatedFiles("pre"));
    await lease.release();
    leases.splice(leases.indexOf(lease), 1);
    await spawnTransactionCrash(project.projectRoot, {
      faultPoint: "after:active-to-backup-rename",
    });
    const replacement = await ProjectLease.acquire({
      projectRoot: project.projectRoot,
      mode: "writer",
    });
    leases.push(replacement);
    const journalRoot = join(project.projectRoot, ".reforce", "transactions", "generated");
    const journalTokens = await readdir(journalRoot);
    const journalPath = join(journalRoot, journalTokens[0] ?? "missing", "journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    await writeFile(
      journalPath,
      `${JSON.stringify({ ...journal, leaseOwnerToken: "unproven-owner" }, undefined, 2)}\n`,
    );
    const recovery = await DirectoryTransactions.create({
      projectRoot: project.projectRoot,
      lease: replacement,
    });

    await expect(recovery.recover()).rejects.toBeInstanceOf(ProjectBusyError);
    expect(await readFile(journalPath, "utf8")).toContain("unproven-owner");
  });

  test("rejects a generated backup whose bytes changed after publication", async () => {
    const { project, lease, transactions } = await setupWriter();
    await transactions.commitGenerated(generatedFiles("pre"));
    await lease.release();
    leases.splice(leases.indexOf(lease), 1);
    await spawnTransactionCrash(project.projectRoot, {
      faultPoint: "after:active-to-backup-rename",
    });
    const reforceRoot = join(project.projectRoot, ".reforce");
    const backupName = (await readdir(reforceRoot)).find((entry) =>
      entry.startsWith("generated.backup-"),
    );
    if (!backupName) {
      throw new Error("Expected a generated backup after the injected crash.");
    }
    await writeFile(join(reforceRoot, backupName, "beans.ts"), "invalid generated bytes\n");
    const replacement = await ProjectLease.acquire({
      projectRoot: project.projectRoot,
      mode: "writer",
    });
    leases.push(replacement);
    const recovery = await DirectoryTransactions.create({
      projectRoot: project.projectRoot,
      lease: replacement,
    });

    await expect(recovery.recover()).rejects.toBeInstanceOf(DirectoryTransactionError);
  });

  test("rejects a dist backup whose asset set changed after publication", async () => {
    const { project, lease, transactions } = await setupWriter();
    const prepared = await transactions.prepareDist();
    await mkdir(join(prepared.stagingDirectory, "chunks"));
    await writeFile(
      join(prepared.stagingDirectory, "main.mjs"),
      'await import("./chunks/pre.mjs");\n',
    );
    await writeFile(join(prepared.stagingDirectory, "chunks", "pre.mjs"), "export {};\n");
    await transactions.commitDist({
      ...prepared,
      expectedFiles: ["chunks/pre.mjs", "main.mjs"],
    });
    await lease.release();
    leases.splice(leases.indexOf(lease), 1);
    await spawnTransactionCrash(
      project.projectRoot,
      { faultPoint: "after:active-to-backup-rename" },
      "dist",
    );
    const backupName = (await readdir(project.projectRoot)).find((entry) =>
      entry.startsWith("dist.backup-"),
    );
    if (!backupName) {
      throw new Error("Expected a dist backup after the injected crash.");
    }
    await unlink(join(project.projectRoot, backupName, "chunks", "pre.mjs"));
    const replacement = await ProjectLease.acquire({
      projectRoot: project.projectRoot,
      mode: "writer",
    });
    leases.push(replacement);
    const recovery = await DirectoryTransactions.create({
      projectRoot: project.projectRoot,
      lease: replacement,
    });

    await expect(recovery.recover()).rejects.toBeInstanceOf(DirectoryTransactionError);
  });

  test("recovers a complete generation across the first half of crash boundaries", async () => {
    await verifyGeneratedCrashBoundaryHalf("first");
  });

  test("recovers a complete generation across the second half of crash boundaries", async () => {
    await verifyGeneratedCrashBoundaryHalf("second");
  });

  test("recovers a complete dist after every instrumented crash boundary", async () => {
    const baseline = await setupWriter();
    await commitDistGeneration(baseline.transactions, "pre");
    const observedPoints: string[] = [];
    const traced = await DirectoryTransactions.create({
      projectRoot: baseline.project.projectRoot,
      lease: baseline.lease,
      faultInjector(point, context) {
        observedPoints.push(`${point}:${context.path ?? ""}`);
      },
    });
    await commitDistGeneration(traced, "post");
    await baseline.lease.release();
    leases.splice(leases.indexOf(baseline.lease), 1);
    await baseline.project.cleanup();
    projects.splice(projects.indexOf(baseline.project), 1);
    expect(observedPoints.length).toBeGreaterThan(20);

    for (const faultIndex of shuffledIndexes(observedPoints.length)) {
      const project = await createTemporaryProject();
      let replacement: ProjectLease | undefined;
      try {
        const initialLease = await ProjectLease.acquire({
          projectRoot: project.projectRoot,
          mode: "writer",
        });
        const initialTransactions = await DirectoryTransactions.create({
          projectRoot: project.projectRoot,
          lease: initialLease,
        });
        await commitDistGeneration(initialTransactions, "pre");
        await initialLease.release();

        const crashedWriterToken = await spawnTransactionCrash(
          project.projectRoot,
          { faultIndex },
          "dist",
          observedPoints[faultIndex],
        );
        replacement = await ProjectLease.acquire({
          projectRoot: project.projectRoot,
          mode: "writer",
        });
        expect(replacement.recoveredWriterTokens).toEqual([crashedWriterToken]);
        const recovery = await DirectoryTransactions.create({
          projectRoot: project.projectRoot,
          lease: replacement,
        });
        await recovery.recover();

        const active = await activeDistGeneration(project.projectRoot);
        expect(["pre", "post"]).toContain(active);
        expect(
          (await readProjectTree(join(project.projectRoot, "dist"))).map((entry) => entry.path),
        ).toEqual([`chunks/${active}.mjs`, "main.mjs"]);
        expect(
          await readdir(join(project.projectRoot, ".reforce", "transactions", "dist")),
        ).toEqual([]);
        const projectEntries = await readdir(project.projectRoot);
        const transactionLeftovers = projectEntries.filter(
          (entry) => entry.startsWith("dist.staging-") || entry.startsWith("dist.backup-"),
        );
        if (transactionLeftovers.length > 0) {
          throw new Error(
            `Crash boundary ${faultIndex} (${observedPoints[faultIndex]}) left ${transactionLeftovers.join(", ")}.`,
          );
        }
      } finally {
        await replacement?.release();
        await project.cleanup();
      }
    }
  });
});
