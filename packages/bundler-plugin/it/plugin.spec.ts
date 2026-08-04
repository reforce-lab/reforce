import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTemporaryProject, type TemporaryProject } from "@reforce/tooling-testing";
import { createRslib, type RslibConfig } from "@rslib/core";
import { reforceStarter } from "@/index";
import { reforceStarterRsbuild } from "@/rsbuild";

// 作者侧插件 IT（ADR 0004 决策 4，#120/#147）：收尾钩子跑库模式编译、meta 写作者配置的输出目录、
// 自动补/校正 exports 的 ./reforce-meta（与 ./reforce）subpath、publint 兜发布事故。库模式编译
// 语义由 compiler 的 library-compile IT 钉住，这里只验插件面。

const projects: TemporaryProject[] = [];

afterEach(async () => {
  await Promise.all(projects.splice(0).map((project) => project.cleanup()));
});

interface LibraryOverrides {
  readonly packageJson?: Record<string, unknown>;
  readonly sources?: Record<string, string>;
}

async function createLibrary(overrides: LibraryOverrides = {}): Promise<TemporaryProject> {
  const project = await createTemporaryProject({
    "package.json": `${JSON.stringify({
      name: "@acme/starter-widget",
      version: "1.0.0",
      type: "module",
      files: ["dist"],
      exports: {
        ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
      },
      ...overrides.packageJson,
    })}\n`,
    "tsconfig.json": `${JSON.stringify({
      compilerOptions: {
        target: "ESNext",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
      },
      include: ["src"],
    })}\n`,
    src: overrides.sources ?? {
      "index.ts": [
        'import { Injectable } from "@reforce/context";',
        "",
        "@Injectable()",
        "export class Widget {}",
        "",
      ].join("\n"),
    },
    dist: {
      "index.d.ts": "export declare class Widget {}\n",
      "index.js": "export class Widget {}\n",
    },
  });
  projects.push(project);
  return project;
}

function writeBundleHook(options: Parameters<typeof reforceStarter.raw>[0]): () => Promise<void> {
  const raw = reforceStarter.raw(options, { framework: "rollup" });
  const plugin = Array.isArray(raw) ? raw[0] : raw;
  const hook = plugin?.writeBundle;
  if (hook === undefined) {
    throw new Error("reforce-starter must register a writeBundle hook");
  }
  return async () => {
    await hook();
  };
}

test("writeBundle compiles meta into the output directory and patches exports", async () => {
  const project = await createLibrary();
  const finish = writeBundleHook({ projectDirectory: project.projectRoot, publint: false });

  await finish();

  const meta = JSON.parse(
    await readFile(join(project.projectRoot, "dist", "reforce-meta.json"), "utf8"),
  );
  expect(meta.schemaVersion).toBe(1);
  expect(meta.beans.map((bean: { id: string }) => bean.id)).toEqual([
    "@acme/starter-widget#Widget",
  ]);
  expect(await readFile(join(project.projectRoot, "dist", "reforce.js"), "utf8")).toContain(
    "export default",
  );
  const packageJson = JSON.parse(await readFile(join(project.projectRoot, "package.json"), "utf8"));
  expect(packageJson.exports["./reforce-meta"]).toBe("./dist/reforce-meta.json");
  expect(packageJson.exports["./reforce"]).toEqual({
    types: "./dist/reforce.d.ts",
    default: "./dist/reforce.js",
  });
});

test("writeBundle keeps an already-correct package.json byte-identical", async () => {
  const project = await createLibrary();
  const finish = writeBundleHook({ projectDirectory: project.projectRoot, publint: false });
  await finish();
  const firstPass = await readFile(join(project.projectRoot, "package.json"), "utf8");

  await finish();

  expect(await readFile(join(project.projectRoot, "package.json"), "utf8")).toBe(firstPass);
});

test("writeBundle honors a custom output directory", async () => {
  const project = await createLibrary();
  const finish = writeBundleHook({
    projectDirectory: project.projectRoot,
    outputDirectory: "build",
    publint: false,
  });

  await finish();

  const meta = JSON.parse(
    await readFile(join(project.projectRoot, "build", "reforce-meta.json"), "utf8"),
  );
  expect(meta.schemaVersion).toBe(1);
  const packageJson = JSON.parse(await readFile(join(project.projectRoot, "package.json"), "utf8"));
  expect(packageJson.exports["./reforce-meta"]).toBe("./build/reforce-meta.json");
});

test("writeBundle surfaces compiler diagnostics as a build error", async () => {
  const project = await createLibrary({
    sources: {
      "index.ts": [
        'import { defineBean } from "@reforce/context";',
        "",
        "export const clock = defineBean({",
        "  create: () => ({ now: () => 0 }),",
        "});",
        "",
      ].join("\n"),
    },
  });
  const finish = writeBundleHook({ projectDirectory: project.projectRoot, publint: false });

  await expect(finish()).rejects.toThrow("UNSUPPORTED_LIBRARY_DECLARATION");
});

test("writeBundle fails on publint errors after patching exports", async () => {
  const project = await createLibrary({
    packageJson: { main: "./missing.js" },
  });
  const finish = writeBundleHook({ projectDirectory: project.projectRoot });

  await expect(finish()).rejects.toThrow("publint");
});

test("verify mode keeps a correct package.json byte-identical", async () => {
  const project = await createLibrary({
    packageJson: {
      exports: {
        ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
        "./reforce": { types: "./dist/reforce.d.ts", default: "./dist/reforce.js" },
        "./reforce-meta": "./dist/reforce-meta.json",
      },
    },
  });
  const original = await readFile(join(project.projectRoot, "package.json"), "utf8");
  const finish = writeBundleHook({
    projectDirectory: project.projectRoot,
    exports: "verify",
    publint: false,
  });

  await finish();

  expect(await readFile(join(project.projectRoot, "package.json"), "utf8")).toBe(original);
});

test("verify mode reports missing starter subpaths without rewriting package.json", async () => {
  const project = await createLibrary();
  const original = await readFile(join(project.projectRoot, "package.json"), "utf8");
  const finish = writeBundleHook({
    projectDirectory: project.projectRoot,
    exports: "verify",
    publint: false,
  });

  await expect(finish()).rejects.toThrow(
    'exports must map "./reforce-meta" to "./dist/reforce-meta.json"',
  );
  expect(await readFile(join(project.projectRoot, "package.json"), "utf8")).toBe(original);
});

// 真实 rslib 构建（dts 走 tsgo）的两个用例：rsbuild-plugin-dts 从项目根 resolve typescript
// 可执行文件，tsgo 又要解析 @reforce/context 的类型，所以把两个包按安装形态以 junction
// 链接进临时项目——junction 在 Windows 无需符号链接权限。
function installedPackageRoot(specifier: string): string {
  return dirname(dirname(fileURLToPath(import.meta.resolve(specifier))));
}

async function linkIntoProject(projectRoot: string, packageName: string): Promise<void> {
  const destination = join(projectRoot, "node_modules", ...packageName.split("/"));
  await mkdir(dirname(destination), { recursive: true });
  await symlink(installedPackageRoot(packageName), destination, "junction");
}

async function createRslibLibrary(): Promise<TemporaryProject> {
  const project = await createTemporaryProject({
    "package.json": `${JSON.stringify({
      name: "@acme/starter-widget",
      version: "1.0.0",
      type: "module",
      files: ["dist", "reforce.js", "reforce.d.ts", "reforce-meta.json"],
      exports: {
        ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
        "./reforce": { types: "./reforce.d.ts", default: "./reforce.js" },
        "./reforce-meta": "./reforce-meta.json",
      },
    })}\n`,
    "tsconfig.json": `${JSON.stringify({
      compilerOptions: {
        target: "ESNext",
        module: "ESNext",
        moduleResolution: "Bundler",
        moduleDetection: "force",
        lib: ["ESNext"],
        types: [],
        rootDir: "./src",
        strict: true,
        verbatimModuleSyntax: true,
        isolatedModules: true,
        skipLibCheck: true,
      },
      include: ["src"],
    })}\n`,
    src: {
      "index.ts": [
        'import { Injectable } from "@reforce/context";',
        "",
        "@Injectable()",
        "export class Widget {}",
        "",
      ].join("\n"),
    },
  });
  projects.push(project);
  await linkIntoProject(project.projectRoot, "typescript");
  await linkIntoProject(project.projectRoot, "@reforce/context");
  return project;
}

// 与 tooling-rslib 基线同形（bundleless + tsgo dts），不经 defineLibraryConfig：库作者项目
// 不在本仓库 workspace 内，基线里的 externalHelpers 会要求临时项目再装 @swc/helpers。
function rslibLibraryConfig(extra: Partial<RslibConfig> = {}): RslibConfig {
  return {
    lib: [{ id: "esm", bundle: false, dts: { tsgo: true }, format: "esm", syntax: "esnext" }],
    output: { target: "node" },
    ...extra,
  };
}

async function runRslibBuild(projectRoot: string, extra: Partial<RslibConfig> = {}): Promise<void> {
  const rslib = await createRslib({ cwd: projectRoot, config: rslibLibraryConfig(extra) });
  await rslib.build();
}

test("the unplugin rspack surface fails a real rslib build before tsgo declarations land", async () => {
  const project = await createRslibLibrary();

  await expect(
    runRslibBuild(project.projectRoot, {
      tools: {
        rspack: {
          plugins: [
            reforceStarter.rspack({
              projectDirectory: project.projectRoot,
              outputDirectory: ".",
              publint: false,
            }),
          ],
        },
      },
    }),
  ).rejects.toThrow("INVALID_LIBRARY_PACKAGE");
}, 120_000);

test("the rsbuild surface finishes a real rslib build after tsgo declarations land", async () => {
  const project = await createRslibLibrary();

  await runRslibBuild(project.projectRoot, {
    plugins: [
      reforceStarterRsbuild({
        projectDirectory: project.projectRoot,
        tsconfigPath: "tsconfig.json",
        outputDirectory: ".",
        exports: "verify",
        publint: false,
      }),
    ],
  });

  const meta = JSON.parse(await readFile(join(project.projectRoot, "reforce-meta.json"), "utf8"));
  expect(meta.schemaVersion).toBe(1);
  expect(meta.beans.map((bean: { id: string }) => bean.id)).toEqual([
    "@acme/starter-widget#Widget",
  ]);
  expect(await readFile(join(project.projectRoot, "reforce.js"), "utf8")).toContain(
    "export default",
  );
  expect(await readFile(join(project.projectRoot, "reforce.d.ts"), "utf8")).toContain("export");
}, 120_000);

test("the bun adapter runs the finishing hook through Bun.build", async () => {
  const project = await createLibrary();

  const build = await Bun.build({
    entrypoints: [join(project.projectRoot, "src", "index.ts")],
    outdir: join(project.projectRoot, "bundle"),
    target: "bun",
    external: ["@reforce/context"],
    plugins: [reforceStarter.bun({ projectDirectory: project.projectRoot, publint: false })],
  });

  expect(build.success).toBe(true);
  const meta = JSON.parse(
    await readFile(join(project.projectRoot, "dist", "reforce-meta.json"), "utf8"),
  );
  expect(meta.schemaVersion).toBe(1);
});
