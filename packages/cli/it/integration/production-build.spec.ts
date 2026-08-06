import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { SourceMap, type SourceMapPayload } from "node:module";
import { isAbsolute, join } from "node:path";
import { createCompiler } from "@reforce/compiler";
import { createTemporaryProject, type TemporaryProject } from "@reforce/tooling-testing";
import { isObject } from "radashi";
import { afterEach, describe, expect, test } from "vitest";
import { buildProductionDist, closeProductionBuild } from "@/bundling/production-dist";

async function arrangeApplicationBuild() {
  const temporaryProject = await createTemporaryProject({
    ".reforce": {
      generated: {
        "bootstrap.ts":
          "export async function bootstrap() { return { close: async () => undefined }; }\n",
      },
    },
    src: { "application.ts": "export {};\n" },
    "tsconfig.json": `${JSON.stringify({
      compilerOptions: {
        target: "ESNext",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        experimentalDecorators: false,
        emitDecoratorMetadata: false,
      },
      include: ["src", ".reforce/generated/**/*.ts"],
    })}\n`,
  });
  const compiler = createCompiler();
  const resolution = await compiler.resolveProject({
    projectDirectory: temporaryProject.projectRoot,
  });
  if (resolution.status === "failure") {
    throw new Error(resolution.diagnostics[0].message);
  }
  const stagingDirectory = join(temporaryProject.projectRoot, "dist.staging-test");
  await mkdir(stagingDirectory);
  return { temporaryProject, stagingDirectory, project: resolution.project };
}

describe("production application build", () => {
  let temporaryProject: TemporaryProject | undefined;

  afterEach(async () => {
    await temporaryProject?.cleanup();
  });

  test("emits a dynamic ESM chunk for the generated bootstrap import", async () => {
    const fixture = await arrangeApplicationBuild();
    temporaryProject = fixture.temporaryProject;

    const files = await buildProductionDist({
      project: fixture.project,
      stagingDirectory: fixture.stagingDirectory,
    });

    expect(files).toContain("main.mjs");
    expect(files.some((file) => file.startsWith("chunks/"))).toBe(true);
    const output = (
      await Promise.all(files.map((file) => readFile(join(fixture.stagingDirectory, file), "utf8")))
    ).join("\n");
    expect(output).toContain("import(");
  });

  test("keeps build-owned entry source out of the application metadata", async () => {
    const fixture = await arrangeApplicationBuild();
    temporaryProject = fixture.temporaryProject;

    await buildProductionDist({
      project: fixture.project,
      stagingDirectory: fixture.stagingDirectory,
    });

    expect((await readdir(join(fixture.temporaryProject.projectRoot, ".reforce"))).sort()).toEqual([
      "generated",
    ]);
  });

  test("excludes build-time compiler dependencies from application output", async () => {
    const fixture = await arrangeApplicationBuild();
    temporaryProject = fixture.temporaryProject;

    const files = await buildProductionDist({
      project: fixture.project,
      stagingDirectory: fixture.stagingDirectory,
    });

    const output = (
      await Promise.all(files.map((file) => readFile(join(fixture.stagingDirectory, file), "utf8")))
    ).join("\n");
    expect(output).not.toContain("@reforce/compiler");
    expect(output).not.toContain("createCompiler");
    expect(output).not.toContain("PARSER_SYNTAX_ERROR");
    expect(output).not.toContain("yuku-parser");
  });

  test("rejects staging files absent from the build asset graph", async () => {
    const fixture = await arrangeApplicationBuild();
    temporaryProject = fixture.temporaryProject;
    await writeFile(join(fixture.stagingDirectory, "unexpected.txt"), "unexpected\n");

    const build = buildProductionDist({
      project: fixture.project,
      stagingDirectory: fixture.stagingDirectory,
    });

    await expect(build).rejects.toThrow(
      "Production staging files do not exactly match the stats asset graph.",
    );
  });

  test("preserves a build failure when closing the build also fails", async () => {
    const buildFailure = new Error("build failed");
    const closeFailure = new Error("close failed");

    const completion = closeProductionBuild(
      {
        close: async () => {
          throw closeFailure;
        },
      },
      [buildFailure],
    );

    const error = await completion.catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error).toMatchObject({ cause: buildFailure, errors: [buildFailure, closeFailure] });
  });
});

// —— 栈帧重定位（RFC 0011 D6，#242）——
// 这条链有五环：nosources-source-map、devtoolModuleFilenameTemplate、两个子进程的
// --enable-source-maps、stats 的伴生产物声明，以及 rspack 把 SWC 的逐模块 map 串成 bundle map
// 的保真度。前四环都是本仓代码，最后一环是外部行为，只能对真实产物实测。

const throwerApplicationTree = {
  ".reforce": {
    generated: {
      "bootstrap.ts": [
        'import { failHere } from "@/thrower";',
        "",
        "export async function bootstrap() {",
        "  failHere();",
        "  return { close: async () => undefined };",
        "}",
        "",
      ].join("\n"),
    },
  },
  src: {
    "thrower.ts": [
      "export function failHere(): never {",
      '  throw new Error("relocation probe");',
      "}",
      "",
    ].join("\n"),
  },
  "tsconfig.json": `${JSON.stringify({
    compilerOptions: {
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      experimentalDecorators: false,
      emitDecoratorMetadata: false,
      baseUrl: ".",
      paths: { "@/*": ["src/*"] },
    },
    include: ["src", ".reforce/generated/**/*.ts"],
  })}\n`,
};

async function buildThrowerApplication(): Promise<{
  readonly temporaryProject: TemporaryProject;
  readonly stagingDirectory: string;
}> {
  const temporaryProject = await createTemporaryProject(throwerApplicationTree);
  const compiler = createCompiler();
  const resolution = await compiler.resolveProject({
    projectDirectory: temporaryProject.projectRoot,
  });
  if (resolution.status === "failure") {
    throw new Error(resolution.diagnostics[0].message);
  }
  const stagingDirectory = join(temporaryProject.projectRoot, "dist.staging-test");
  await mkdir(stagingDirectory);
  await buildProductionDist({ project: resolution.project, stagingDirectory });
  return { temporaryProject, stagingDirectory };
}

async function emittedMapSources(stagingDirectory: string): Promise<readonly string[]> {
  // thrower.ts 被 bootstrap 引用，落在动态 chunk 里，所以两个 map 都要看。
  const mapFiles = [
    join(stagingDirectory, "main.mjs.map"),
    ...(await readdir(join(stagingDirectory, "chunks")))
      .filter((file) => file.endsWith(".mjs.map"))
      .map((file) => join(stagingDirectory, "chunks", file)),
  ];
  const sources: string[] = [];
  for (const mapFile of mapFiles) {
    const map: unknown = JSON.parse(await readFile(mapFile, "utf8"));
    const mapSources = isObject(map) ? Reflect.get(map, "sources") : undefined;
    for (const source of Array.isArray(mapSources) ? mapSources : []) {
      if (typeof source === "string") {
        sources.push(source);
      }
    }
  }
  return sources;
}

async function locateBundledThrow(stagingDirectory: string): Promise<{
  readonly sourceMap: SourceMap;
  readonly line: number;
  readonly column: number;
}> {
  const chunkFile = (await readdir(join(stagingDirectory, "chunks"))).find((file) =>
    file.endsWith(".mjs"),
  );
  const chunkPath = join(stagingDirectory, "chunks", chunkFile ?? "");
  const chunkLines = (await readFile(chunkPath, "utf8")).split("\n");
  const line = chunkLines.findIndex((text) => text.includes('"relocation probe"'));
  const payload: SourceMapPayload = JSON.parse(await readFile(`${chunkPath}.map`, "utf8"));
  return {
    sourceMap: new SourceMap(payload),
    line,
    column: (chunkLines[line] ?? "").indexOf("throw"),
  };
}

describe("production stack frame relocation", () => {
  let temporaryProject: TemporaryProject | undefined;

  afterEach(async () => {
    await temporaryProject?.cleanup();
  });

  // 相对 source 会被 Node 按「生成文件所在目录」解析，指向 dist/src/… 这种不存在的路径。
  test("bases emitted sources on absolute paths that can actually be opened", async () => {
    const built = await buildThrowerApplication();
    temporaryProject = built.temporaryProject;

    const sources = await emittedMapSources(built.stagingDirectory);

    const throwerSource = sources.find((source) => source.endsWith("src/thrower.ts"));
    expect(
      throwerSource,
      `no source ended with src/thrower.ts: ${JSON.stringify(sources)}`,
    ).toBeDefined();
    expect(isAbsolute(throwerSource ?? "")).toBe(true);
  }, 60_000);

  // 保真度这一环是外部行为，不能靠读配置断定。node:module 的 SourceMap 正是
  // --enable-source-maps 内部使用的同一个消费者，且它把「文件 + 行」一起钉死，不依赖
  // 打包产物的导出形态。
  test("maps the bundled throw back to its original file and line", async () => {
    const built = await buildThrowerApplication();
    temporaryProject = built.temporaryProject;

    const { sourceMap, line, column } = await locateBundledThrow(built.stagingDirectory);

    expect(line).toBeGreaterThanOrEqual(0);
    const entry = sourceMap.findEntry(line, column);
    expect(entry.originalSource?.endsWith("src/thrower.ts")).toBe(true);
    // thrower.ts 的 throw 在第 2 行；SourceMap 的行号是 0-based。
    expect(entry.originalLine).toBe(1);
  }, 60_000);
});
