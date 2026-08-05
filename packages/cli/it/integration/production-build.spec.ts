import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCompiler } from "@reforce/compiler";
import { createTemporaryProject, type TemporaryProject } from "@reforce/tooling-testing";
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
