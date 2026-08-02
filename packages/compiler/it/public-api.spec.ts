import { afterEach, expect, test } from "bun:test";
import type { TemporaryProject } from "@reforce/tooling-testing";
import { createCompiler } from "@/index";
import { createPositiveApplication, resolveProjectOrThrow } from "./support/project";

const temporaryProjects: TemporaryProject[] = [];

afterEach(async () => {
  await Promise.all(temporaryProjects.splice(0).map((project) => project.cleanup()));
});

async function standaloneApplication(): Promise<TemporaryProject> {
  const project = await createPositiveApplication();
  temporaryProjects.push(project);
  return project;
}

test("the root entry exposes only the Compiler factory at runtime", async () => {
  const publicApi = await import("@/index");

  expect(Object.keys(publicApi)).toEqual(["createCompiler"]);
});

test("resolves and compiles an application through the public two-stage API", async () => {
  const application = await standaloneApplication();
  const compiler = createCompiler();
  const project = await resolveProjectOrThrow(compiler, application.projectRoot);

  const result = await compiler.compile({ project });

  expect(result.status).toBe("success");
});

test("rejects a project issued by another Compiler instance", async () => {
  const application = await standaloneApplication();
  const issuer = createCompiler();
  const project = await resolveProjectOrThrow(issuer, application.projectRoot);
  const otherCompiler = createCompiler();

  const result = await otherCompiler.compile({ project });

  expect(result.status).toBe("failure");
  expect(result.diagnostics[0]?.code).toBe("PROJECT_CONFIG_CHANGED");
});
