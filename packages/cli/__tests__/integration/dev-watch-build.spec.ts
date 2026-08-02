import { afterEach, expect, test } from "bun:test";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createCompiler } from "@reforce/compiler";
import { yukuFrontend } from "@reforce/compiler-yuku";
import { createTemporaryProject, type TemporaryProject } from "@reforce/tooling-testing";
import { DevCompilerGate } from "#internal/dev-compiler-gate";
import { startDevWatchBuild } from "#internal/dev-watch-build";
import type { DevCompilation } from "#internal/dev-watch-coordinator";
import { DirectoryTransactions } from "#internal/directory-transaction";
import { ProjectLease } from "#internal/project-lease";

const workspaceRoot = resolve("../..");
const contextSourceRoot = join(workspaceRoot, "packages", "context", "src");
const projects: TemporaryProject[] = [];
const leases: ProjectLease[] = [];
const watches: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  for (const watch of watches.splice(0).reverse()) {
    await watch.close();
  }
  for (const lease of leases.splice(0).reverse()) {
    await lease.release();
  }
  for (const project of projects.splice(0).reverse()) {
    await project.cleanup();
  }
});

async function setupWatch(
  onCompilation: (compilation: DevCompilation) => Promise<void>,
  onInvalidated?: (path: string | null) => void,
  sourceFiles: Readonly<Record<string, string>> = {
    "application.ts": `import { Injectable } from "@reforce/context";

@Injectable()
export class ApplicationService {}
`,
  },
): Promise<TemporaryProject> {
  const project = await createTemporaryProject({
    "tsconfig.json": `${JSON.stringify({
      compilerOptions: {
        target: "ESNext",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        experimentalDecorators: false,
        emitDecoratorMetadata: false,
        baseUrl: ".",
        paths: {
          "@reforce/context": [join(contextSourceRoot, "index.ts")],
          "@reforce/context/*": [join(contextSourceRoot, "*.ts")],
        },
      },
      include: ["src", ".reforce/generated/**/*.d.ts"],
    })}\n`,
    src: sourceFiles,
  });
  projects.push(project);
  const compiler = createCompiler();
  const resolution = await compiler.resolveProject({ projectDirectory: project.projectRoot });
  if (resolution.status === "failure") {
    throw new Error(resolution.diagnostics[0].message);
  }
  const lease = await ProjectLease.acquire({ projectRoot: project.projectRoot, mode: "writer" });
  leases.push(lease);
  const transactions = await DirectoryTransactions.create({
    projectRoot: project.projectRoot,
    lease,
  });
  const gate = new DevCompilerGate({
    compiler,
    frontend: yukuFrontend,
    projectDirectory: project.projectRoot,
    project: resolution.project,
    initialWatchInputs: resolution.watchInputs,
    generatedOutput: transactions,
  });
  const initial = await gate.initialize();
  if (initial.status !== "success") {
    throw new Error("Expected the initial compiler gate to succeed.");
  }
  const watch = await startDevWatchBuild({
    project: resolution.project,
    gate,
    onCompilation,
    ...(onInvalidated ? { onInvalidated } : {}),
  });
  watches.push(watch);
  return project;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for development compilation.");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

test("Rsbuild watch emits a Node ESM entry after the compiler gate commits generated output", async () => {
  const compiled = Promise.withResolvers<DevCompilation>();
  const project = await setupWatch(async (compilation) => compiled.resolve(compilation));

  const result = await compiled.promise;

  expect(result.status).toBe("success");
  expect(
    await readFile(join(project.projectRoot, ".reforce", "dev", "main.mjs"), "utf8"),
  ).toContain("reforce:application-bootstrap");
});

test("keeps the development entry source inside the build graph", async () => {
  const compiled = Promise.withResolvers<DevCompilation>();
  const project = await setupWatch(async (compilation) => compiled.resolve(compilation));

  const result = await compiled.promise;

  expect(result.status).toBe("success");
  expect((await readdir(join(project.projectRoot, ".reforce"))).sort()).toEqual([
    "dev",
    "generated",
    "lease",
    "transactions",
  ]);
});

test("Rsbuild watch emits source maps for the Node ESM entry", async () => {
  const compiled = Promise.withResolvers<DevCompilation>();
  const project = await setupWatch(async (compilation) => compiled.resolve(compilation));

  const result = await compiled.promise;

  expect(result.status).toBe("success");
  expect(
    await readFile(join(project.projectRoot, ".reforce", "dev", "main.mjs.map"), "utf8"),
  ).toContain('"version":3');
});

test("a source edit rebuilds once without a generated-output invalidation", async () => {
  const compilations: DevCompilation[] = [];
  const invalidations: Array<string | null> = [];
  const project = await setupWatch(
    async (compilation) => {
      compilations.push(compilation);
    },
    (path) => invalidations.push(path),
  );
  await waitUntil(() => compilations.length === 1);

  await writeFile(
    join(project.projectRoot, "src", "application.ts"),
    `import { Injectable } from "@reforce/context";

@Injectable()
export class ApplicationService {
  value(): string {
    return "updated";
  }
}
`,
  );
  await waitUntil(() => compilations.length >= 2);
  await new Promise<void>((resolve) => setTimeout(resolve, 500));

  expect({
    statuses: compilations.map((compilation) => compilation.status),
    invalidations,
  }).toEqual({
    statuses: ["success", "success"],
    invalidations: [join(project.projectRoot, "src", "application.ts")],
  });
});

test("an extended configuration outside projectRoot invalidates the application watch", async () => {
  const sharedConfig = {
    compilerOptions: {
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      experimentalDecorators: false,
      emitDecoratorMetadata: false,
      baseUrl: ".",
      paths: {
        "@reforce/context": [join(contextSourceRoot, "index.ts")],
        "@reforce/context/*": [join(contextSourceRoot, "*.ts")],
      },
    },
  };
  const project = await createTemporaryProject({
    apps: {
      api: {
        src: {
          "application.ts": `import { Injectable } from "@reforce/context";

@Injectable()
export class ApplicationService {}
`,
        },
        "tsconfig.json": `${JSON.stringify({
          extends: "../../tsconfig.shared.json",
          include: ["src", ".reforce/generated/**/*.d.ts"],
        })}\n`,
      },
    },
    "tsconfig.shared.json": `${JSON.stringify(sharedConfig)}\n`,
  });
  projects.push(project);
  const projectRoot = join(project.projectRoot, "apps", "api");
  const compiler = createCompiler();
  const resolution = await compiler.resolveProject({ projectDirectory: projectRoot });
  if (resolution.status === "failure") {
    throw new Error(resolution.diagnostics[0].message);
  }
  const lease = await ProjectLease.acquire({ projectRoot, mode: "writer" });
  leases.push(lease);
  const transactions = await DirectoryTransactions.create({ projectRoot, lease });
  const gate = new DevCompilerGate({
    compiler,
    frontend: yukuFrontend,
    projectDirectory: projectRoot,
    project: resolution.project,
    initialWatchInputs: resolution.watchInputs,
    generatedOutput: transactions,
  });
  await gate.initialize();
  const compilations: DevCompilation[] = [];
  const invalidations: Array<string | null> = [];
  const watch = await startDevWatchBuild({
    project: resolution.project,
    gate,
    onCompilation: async (compilation) => {
      compilations.push(compilation);
    },
    onInvalidated: (path) => invalidations.push(path),
  });
  watches.push(watch);
  await waitUntil(() => compilations.length === 1);
  const sharedConfigPath = join(project.projectRoot, "tsconfig.shared.json");

  await writeFile(
    sharedConfigPath,
    `${JSON.stringify({
      ...sharedConfig,
      compilerOptions: { ...sharedConfig.compilerOptions, noImplicitOverride: true },
    })}\n`,
  );
  await waitUntil(() => compilations.length === 2);

  expect(invalidations).toContain(sharedConfigPath);
  expect(compilations.map((compilation) => compilation.status)).toEqual(["success", "success"]);
});

test("creating a source file rebuilds once and discovers its Bean", async () => {
  const compilations: DevCompilation[] = [];
  const project = await setupWatch(async (compilation) => {
    compilations.push(compilation);
  });
  await waitUntil(() => compilations.length === 1);
  const createdSourcePath = join(project.projectRoot, "src", "created.ts");

  await writeFile(
    createdSourcePath,
    `import { Injectable } from "@reforce/context";

@Injectable()
export class CreatedService {}
`,
  );
  await waitUntil(() => compilations.length >= 2);
  await new Promise<void>((resolve) => setTimeout(resolve, 500));

  expect(compilations.map((compilation) => compilation.status)).toEqual(["success", "success"]);
  expect(
    await readFile(join(project.projectRoot, ".reforce", "generated", "beans.ts"), "utf8"),
  ).toContain("CreatedService");
});

test("deleting a source file rebuilds once and removes its Bean", async () => {
  const compilations: DevCompilation[] = [];
  const project = await setupWatch(
    async (compilation) => {
      compilations.push(compilation);
    },
    undefined,
    {
      "application.ts": `import { Injectable } from "@reforce/context";

@Injectable()
export class ApplicationService {}
`,
      "removable.ts": `import { Injectable } from "@reforce/context";

@Injectable()
export class RemovableService {}
`,
    },
  );
  await waitUntil(() => compilations.length === 1);
  const generatedBeansPath = join(project.projectRoot, ".reforce", "generated", "beans.ts");
  expect(await readFile(generatedBeansPath, "utf8")).toContain("RemovableService");

  await rm(join(project.projectRoot, "src", "removable.ts"));
  await waitUntil(() => compilations.length >= 2);
  await new Promise<void>((resolve) => setTimeout(resolve, 500));

  expect(compilations.map((compilation) => compilation.status)).toEqual(["success", "success"]);
  expect(await readFile(generatedBeansPath, "utf8")).not.toContain("RemovableService");
});
