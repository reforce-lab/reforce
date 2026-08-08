import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { GeneratedApplicationDefinition } from "@reforce/core/generated-runtime";
import { createTestContext } from "@reforce/testing";
import {
  bundleEntry,
  copyApplicationProject,
  createTemporaryProject,
  resolveNodeExecutable,
  runCommand,
  type TemporaryProject,
} from "@reforce/tooling-testing";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { installApplicationPackages } from "../support/application-packages";

// @reforce/testing 的用户链路 e2e（ADR 0007 T3，#143/#149/#189）：对真实 cli build 生成的
// GeneratedApplicationDefinition 验证 createTestContext 的替换语义——替换只发生在 create，
// 依赖边与 plans 原样保留；原钩子换 no-op，替身即使带同名钩子也不进上下文生命周期。
// 包内单测只用手写 definition，这里补上"用户拿构建产物做测试"的完整链路。

const e2eRoot = fileURLToPath(new URL("..", import.meta.url));
const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));
const cliEntry = join(workspaceRoot, "packages", "devkit", "cli", "dist", "reforce.js");
const applicationFixture = join(e2eRoot, "fixtures", "application");
const commandTimeout = 120_000;

// 类形状锚定在 fixture 模板上：临时副本与模板同源，模板漂移由 fixture 自身 typecheck 兜住。
type GreetingModule = typeof import("../fixtures/application/src/greeting");

let project: TemporaryProject | undefined;
let builtDefinition: GeneratedApplicationDefinition | undefined;
let greetingModule: GreetingModule | undefined;

beforeAll(async () => {
  project = await createTemporaryProject();
  await copyApplicationProject(applicationFixture, project.projectRoot);
  await installApplicationPackages(project.projectRoot);
  const nodeExecutable = await resolveNodeExecutable();
  const build = await runCommand(nodeExecutable, [cliEntry, "build", "--project", "."], {
    cwd: project.projectRoot,
    timeout: commandTimeout,
  });
  if (build.exitCode !== 0) {
    throw new Error(`fixture build failed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`);
  }
  // 直接 import 生成物/源码行不通：fixture 的 @/ 别名只对 temp 工程的 tsconfig 有意义，
  // vitest 的全局别名指向本包 src；且 src 的 TC39 装饰器需要 SWC 降级。打包成单文件 mjs
  // 后两个约束同时消解（#207）。
  await writeFile(
    join(project.projectRoot, "test-entry.ts"),
    [
      'export { applicationDefinition } from "./.reforce/generated/beans";',
      'export * as greeting from "./src/greeting";',
      "",
    ].join("\n"),
  );
  const bundlePath = join(project.projectRoot, "dist", "test-entry.mjs");
  await bundleEntry({ entry: "test-entry.ts", cwd: project.projectRoot, outfile: bundlePath });
  // 两个模块在编译期之外落盘（构建产物 + fixture 临时副本），tsc 看不见动态路径背后的类型：
  // definition 的结构校验交给 createApplicationContext（ADR 0007 T3，testing 不新增校验通道）。
  const bundle = (await import(pathToFileURL(bundlePath).href)) as {
    applicationDefinition: GeneratedApplicationDefinition;
    greeting: GreetingModule;
  };
  builtDefinition = bundle.applicationDefinition;
  greetingModule = bundle.greeting;
}, commandTimeout);

afterAll(async () => {
  await project?.cleanup();
});

function definition(): GeneratedApplicationDefinition {
  if (builtDefinition === undefined) {
    throw new Error("Fixture application has not been built.");
  }
  return builtDefinition;
}

function fixtureClasses(): GreetingModule {
  if (greetingModule === undefined) {
    throw new Error("Fixture application has not been built.");
  }
  return greetingModule;
}

describe("createTestContext over the built definition", () => {
  test("a replaced dependency Bean flows through the generated dependency edges", async () => {
    const { GreetingService, MessageRepository } = fixtureClasses();

    const context = await createTestContext(definition(), (overrides) => {
      overrides.replace(MessageRepository, { value: () => "stubbed" });
    });

    try {
      expect(context.get(GreetingService).greet()).toBe("stubbed");
    } finally {
      await context.close();
    }
  });

  test("replacing a Bean keeps every lifecycle hook away from both the original and the double", async () => {
    const { GreetingService, MessageRepository } = fixtureClasses();
    // 替身用真实类构造：类型上就是 T（NoInfer 钉住），同名钩子也真实存在——若上下文误调
    // 任何一侧钩子，静态 events 都会增长。
    const double = new GreetingService(new MessageRepository());
    const baseline = GreetingService.events.length;

    const context = await createTestContext(definition(), (overrides) => {
      overrides.replace(GreetingService, double);
    });

    try {
      expect(context.get(GreetingService)).toBe(double);
      expect(GreetingService.events.length).toBe(baseline);
    } finally {
      await context.close();
    }
    expect(GreetingService.events.length).toBe(baseline);
  });
});
