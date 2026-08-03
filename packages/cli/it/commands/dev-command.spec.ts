import { afterEach, describe, expect, test } from "bun:test";
import { access, cp, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createTemporaryProject,
  type ProjectTree,
  resolveBunExecutable,
  type TemporaryProject,
} from "@reforce/tooling-testing";
import { execa, type ResultPromise } from "execa";

const harnessPath = fileURLToPath(
  new URL("../support/process/dev/dev-command.harness.ts", import.meta.url),
);
const windowsSignalHarnessPath = fileURLToPath(
  new URL("../support/process/windows-signal.harness.ts", import.meta.url),
);
const bunExecutable = await resolveBunExecutable();
const workspaceRoot = resolve("../..");
const contextRoot = join(workspaceRoot, "packages", "context");
const bunTypesRoot = fileURLToPath(new URL(".", import.meta.resolve("@types/bun/package.json")));
const radashiRoot = fileURLToPath(new URL("..", import.meta.resolve("radashi")));
const projects: TemporaryProject[] = [];
const processes: ResultPromise[] = [];

function spawnDevCommandHarness(arguments_: readonly string[]): ResultPromise {
  const harnessArguments = [harnessPath, ...arguments_];
  return execa(
    bunExecutable,
    [
      ...(process.platform === "win32"
        ? [windowsSignalHarnessPath, ...harnessArguments]
        : harnessArguments),
    ],
    {
      reject: false,
      shell: false,
      ...(process.platform === "win32" ? { ipc: true, serialization: "json" as const } : {}),
    },
  );
}

async function requestGracefulShutdown(subprocess: ResultPromise): Promise<void> {
  if (process.platform === "win32") {
    const sendMessage = subprocess.sendMessage;
    if (sendMessage === undefined) {
      throw new Error("The Windows signal-event harness has no IPC channel.");
    }
    await sendMessage.call(subprocess, { type: "reforce:e2e-signal", signal: "SIGBREAK" });
    return;
  }
  if (!subprocess.kill("SIGINT")) {
    throw new Error("Unable to deliver SIGINT to the development command harness.");
  }
}

afterEach(async () => {
  for (const subprocess of processes.splice(0).reverse()) {
    subprocess.kill();
    await subprocess;
  }
  for (const project of projects.splice(0).reverse()) {
    await project.cleanup();
  }
});

function applicationProjectTree() {
  return {
    "tsconfig.json": `${JSON.stringify({
      compilerOptions: {
        target: "ESNext",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        experimentalDecorators: false,
        emitDecoratorMetadata: false,
      },
      include: ["src", ".reforce/generated/**/*.d.ts"],
    })}\n`,
    src: {
      "application.ts": `import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Injectable, type OnContextClose, type OnContextStart } from "@reforce/context";

@Injectable()
export class ApplicationService implements OnContextStart, OnContextClose {
  onContextStart(): void {
    writeFileSync(join(process.cwd(), "started.txt"), "started\\n");
  }

  onContextClose(): void {
    writeFileSync(join(process.cwd(), "closed.txt"), "closed\\n");
  }
}
`,
    },
  } satisfies ProjectTree;
}

async function createApplicationProject(tree: ProjectTree): Promise<TemporaryProject> {
  const project = await createTemporaryProject(tree);
  projects.push(project);
  const contextTarget = join(project.projectRoot, "node_modules", "@reforce", "context");
  await Promise.all([
    mkdir(contextTarget, { recursive: true }),
    mkdir(join(project.projectRoot, "node_modules", "@types"), { recursive: true }),
  ]);
  await Promise.all([
    cp(join(contextRoot, "package.json"), join(contextTarget, "package.json")),
    cp(join(contextRoot, "dist"), join(contextTarget, "dist"), { recursive: true }),
    symlink(
      bunTypesRoot,
      join(project.projectRoot, "node_modules", "@types", "bun"),
      process.platform === "win32" ? "junction" : "dir",
    ),
    cp(radashiRoot, join(project.projectRoot, "node_modules", "radashi"), { recursive: true }),
  ]);
  return project;
}

const initialHmrApplicationSource = `import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { Injectable, type OnContextClose, type OnContextStart } from "@reforce/context";

const generation = "one";

@Injectable()
export class ApplicationService implements OnContextStart, OnContextClose {
  onContextStart(): void {
    appendFileSync(join(process.cwd(), "events.txt"), "start:" + generation + "\\n");
  }

  onContextClose(): void {
    appendFileSync(join(process.cwd(), "events.txt"), "close:" + generation + "\\n");
  }
}
`;

const updatedHmrApplicationSource = initialHmrApplicationSource.replace(
  'const generation = "one";',
  'const generation = "two";',
);

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the development command.");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

async function readEvents(projectRoot: string): Promise<readonly string[]> {
  try {
    return (await readFile(join(projectRoot, "events.txt"), "utf8"))
      .trim()
      .split("\n")
      .filter((event) => event.length > 0);
  } catch {
    return [];
  }
}

async function snapshotFiles(root: string, directory = root): Promise<Map<string, Buffer>> {
  const snapshot = new Map<string, Buffer>();
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [nestedPath, bytes] of await snapshotFiles(root, path)) {
        snapshot.set(nestedPath, bytes);
      }
      continue;
    }
    snapshot.set(relative(root, path).split(sep).join("/"), await readFile(path));
  }
  return snapshot;
}

function changedFiles(before: ReadonlyMap<string, Buffer>, after: ReadonlyMap<string, Buffer>) {
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  return paths.filter((path) => {
    const beforeBytes = before.get(path);
    const afterBytes = after.get(path);
    return beforeBytes === undefined || afterBytes === undefined || !beforeBytes.equals(afterBytes);
  });
}

async function runScenario(input: {
  readonly cwd: string;
  readonly projectDirectory: string;
  readonly projectRoot: string;
}): Promise<void> {
  const subprocess = spawnDevCommandHarness([input.cwd, input.projectDirectory]);
  processes.push(subprocess);
  try {
    await waitUntil(() => exists(join(input.projectRoot, "started.txt")));
  } catch {
    subprocess.kill();
    const failed = await subprocess;
    processes.splice(processes.indexOf(subprocess), 1);
    throw new Error(
      `Development command did not start. stdout=${String(failed.stdout)} stderr=${String(failed.stderr)}`,
    );
  }

  await requestGracefulShutdown(subprocess);
  const result = await subprocess;
  processes.splice(processes.indexOf(subprocess), 1);

  if (result.exitCode !== 0) {
    throw new Error(
      `Development command exited with ${String(result.exitCode)}. stdout=${String(result.stdout)} stderr=${String(result.stderr)}`,
    );
  }
  expect(await exists(join(input.projectRoot, "closed.txt"))).toBe(true);
  expect(await exists(join(input.projectRoot, ".reforce", "lease", "writer", "record.json"))).toBe(
    false,
  );
}

describe("development command", () => {
  test("builds, starts, and gracefully closes a standalone application", async () => {
    const project = await createApplicationProject(applicationProjectTree());

    await runScenario({
      cwd: project.projectRoot,
      projectDirectory: ".",
      projectRoot: project.projectRoot,
    });
  }, 30_000);

  test("reports a lease release failure as shutdown failure after graceful close", async () => {
    const project = await createApplicationProject(applicationProjectTree());
    const subprocess = spawnDevCommandHarness([project.projectRoot, ".", "", "fail-release"]);
    processes.push(subprocess);
    await waitUntil(() => exists(join(project.projectRoot, "started.txt")));

    await requestGracefulShutdown(subprocess);
    const result = await subprocess;
    processes.splice(processes.indexOf(subprocess), 1);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[SHUTDOWN_FAILED]");
    expect(result.stderr).not.toContain("CLI_USAGE_ERROR");
    expect(
      await exists(join(project.projectRoot, ".reforce", "lease", "writer", "record.json")),
    ).toBe(false);
  }, 30_000);

  test("selects a monorepo application without writing outputs at the invocation root", async () => {
    const project = await createApplicationProject({
      apps: { api: applicationProjectTree() },
      "package.json": `${JSON.stringify({ private: true, type: "module" })}\n`,
    });
    const applicationRoot = join(project.projectRoot, "apps", "api");

    await runScenario({
      cwd: project.projectRoot,
      projectDirectory: "apps/api",
      projectRoot: applicationRoot,
    });

    expect(await exists(join(project.projectRoot, ".reforce"))).toBe(false);
  }, 30_000);

  test("applies a real Bun ESM hot update only after the previous Context closes", async () => {
    const tree = applicationProjectTree();
    const project = await createApplicationProject({
      ...tree,
      src: {
        ...tree.src,
        "application.ts": initialHmrApplicationSource,
      },
    });
    const subprocess = spawnDevCommandHarness([project.projectRoot, "."]);
    processes.push(subprocess);
    let stderr = "";
    subprocess.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    await waitUntil(async () => (await readEvents(project.projectRoot)).includes("start:one"));

    await writeFile(
      join(project.projectRoot, "src", "application.ts"),
      updatedHmrApplicationSource,
    );
    try {
      await waitUntil(async () => (await readEvents(project.projectRoot)).includes("start:two"));
    } catch (error) {
      throw new Error(
        `Development command did not recover. events=${JSON.stringify(await readEvents(project.projectRoot))} stderr=${stderr}`,
        { cause: error },
      );
    }

    expect((await readEvents(project.projectRoot)).slice(0, 3)).toEqual([
      "start:one",
      "close:one",
      "start:two",
    ]);
    await requestGracefulShutdown(subprocess);
    const result = await subprocess;
    processes.splice(processes.indexOf(subprocess), 1);

    expect(result.exitCode).toBe(0);
    expect(await readEvents(project.projectRoot)).toEqual([
      "start:one",
      "close:one",
      "start:two",
      "close:two",
    ]);
  }, 30_000);

  test("keeps the healthy child and assets through a failed rebuild", async () => {
    const tree = applicationProjectTree();
    const project = await createApplicationProject({
      ...tree,
      src: {
        ...tree.src,
        "application.ts": initialHmrApplicationSource,
      },
    });
    const subprocess = spawnDevCommandHarness([project.projectRoot, "."]);
    processes.push(subprocess);
    let stderr = "";
    subprocess.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    await waitUntil(async () => (await readEvents(project.projectRoot)).includes("start:one"));
    const devOutputRoot = join(project.projectRoot, ".reforce", "dev");
    const healthyAssets = await snapshotFiles(devOutputRoot);

    const applicationPath = join(project.projectRoot, "src", "application.ts");
    await writeFile(applicationPath, "export class Broken {\n");
    await waitUntil(async () => stderr.includes("PARSER_SYNTAX_ERROR"));

    const eventsAfterFailure = await readEvents(project.projectRoot);
    const assetsAfterFailure = await snapshotFiles(devOutputRoot);
    if (eventsAfterFailure.join(",") !== "start:one") {
      throw new Error(
        `Failed compilation changed the healthy child. events=${JSON.stringify(eventsAfterFailure)} files=${JSON.stringify([...healthyAssets.keys()])} assets=${JSON.stringify(changedFiles(healthyAssets, assetsAfterFailure))} stderr=${stderr}`,
      );
    }
    expect(assetsAfterFailure).toEqual(healthyAssets);

    await writeFile(applicationPath, updatedHmrApplicationSource);
    try {
      await waitUntil(async () => (await readEvents(project.projectRoot)).includes("start:two"));
    } catch (error) {
      throw new Error(
        `Development command did not recover after a failed compilation. events=${JSON.stringify(await readEvents(project.projectRoot))} stderr=${stderr}`,
        { cause: error },
      );
    }
    await requestGracefulShutdown(subprocess);
    const result = await subprocess;
    processes.splice(processes.indexOf(subprocess), 1);

    expect(result.exitCode).toBe(0);
  }, 30_000);
});
