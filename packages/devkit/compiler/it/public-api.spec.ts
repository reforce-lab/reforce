import type { TemporaryProject } from "@reforce/tooling-testing";
import { afterEach, expect, test } from "vitest";
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

// 运行期值只有工厂、诊断码表与诊断构造口：码表随 ADR 0013 决议 2 加入（#289：码表以数组为
// 真相，而 @reforce/cli 的 code-registry 要在运行期读到它）；构造口随 #367 加入（诊断形状是
// 去重键的输入，手搓字面量会与工厂构造的同内容诊断错开键）。其余公开面全是类型。
test("the root entry exposes only the Compiler factory, the code table and the diagnostic constructor", async () => {
  const publicApi = await import("@/index");

  expect(Object.keys(publicApi).sort()).toEqual([
    "compilerDiagnosticCodes",
    "createCompiler",
    "diagnostic",
  ]);
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
