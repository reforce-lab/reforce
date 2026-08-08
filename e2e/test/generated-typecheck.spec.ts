import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  copyApplicationProject,
  createTemporaryProject,
  resolveNodeExecutable,
  runCommand,
  type TemporaryProject,
} from "@reforce/tooling-testing";
import { afterEach, describe, expect, test } from "vitest";
import { installApplicationPackages } from "../support/application-packages";

// 生成物进用户编译单元的安全网（#350）。
//
// `.reforce/generated` 的一半是 .d.ts，另一半是普通 TypeScript：beans.ts 调用户的构造器、
// 拼织入链、import 契约，bootstrap.ts 还要接住框架 logger。这一半此前从不进任何类型检查——
// 应用 tsconfig 的 include 只收 `**/*.d.ts`——所以 emission 写错实参个数一类的缺陷只能等到
// 运行期才现形（#350 的成因就是这样一路静默到首次字段访问）。
//
// 这里跑的是用户视角的真 tsc：真 reforce build 落盘，再用仓库的 tsc 编被测项目自己的
// tsconfig。它不断言生成物长什么样，只断言"编得过"，因此不会随 emission 的措辞改动而假红。

const e2eRoot = fileURLToPath(new URL("..", import.meta.url));
const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));
const cliEntry = join(workspaceRoot, "packages", "devkit", "cli", "dist", "reforce.js");
// bin/tsc 是 JS 入口，用 node 起它，避免 .bin 的 shim 在 Windows runner 上要走 shell。
const tscEntry = join(workspaceRoot, "node_modules", "typescript", "bin", "tsc");
const applicationFixture = join(e2eRoot, "fixtures", "application");
const commandTimeout = 120_000;
const nodeExecutable = await resolveNodeExecutable();

const projects: TemporaryProject[] = [];

afterEach(async () => {
  await Promise.all(projects.splice(0).map((project) => project.cleanup()));
});

async function buildAndTypecheck(projectRoot: string): Promise<void> {
  const build = await runCommand(nodeExecutable, [cliEntry, "build", "--project", projectRoot], {
    timeout: commandTimeout,
  });
  expect(build.exitCode, `${build.stdout}\n${build.stderr}`).toBe(0);

  const typecheck = await runCommand(
    nodeExecutable,
    [tscEntry, "-p", join(projectRoot, "tsconfig.json")],
    { cwd: projectRoot, timeout: commandTimeout },
  );
  expect(typecheck.exitCode, `${typecheck.stdout}\n${typecheck.stderr}`).toBe(0);
}

function leafTsconfig(): string {
  return `${JSON.stringify({
    extends: "@reforce/tooling-tsconfig/base.json",
    compilerOptions: { types: ["node"] },
    include: ["src", ".reforce/generated/**/*.ts"],
  })}\n`;
}

describe("生成物在用户 tsconfig 下的类型检查", () => {
  test(
    "带 web 引擎与日志绑定的 fixture 应用，生成物编得过",
    async () => {
      const project = await createTemporaryProject();
      projects.push(project);
      await copyApplicationProject(applicationFixture, project.projectRoot);
      await installApplicationPackages(project.projectRoot, "workspace");

      await buildAndTypecheck(project.projectRoot);
    },
    commandTimeout * 2,
  );

  test(
    "无引擎但装了日志绑定的应用，生成物编得过",
    async () => {
      // renderPlainBootstrap 的 observed 分支：没有 routes/engines 两节，但同样要接住框架
      // logger——`let frameworkLoggingValue` 少了标注就是在这条路径上炸的。
      const project = await createTemporaryProject({
        "tsconfig.json": leafTsconfig(),
        src: {
          "application.ts": [
            'import { defineApplication, Injectable } from "@reforce/core";',
            'import { logging } from "@reforce/logging";',
            "",
            "@Injectable()",
            "export class GreetingService {",
            '  greet(): string { return "hello"; }',
            "}",
            "",
            "export default defineApplication({ starters: [logging] });",
            "",
          ].join("\n"),
        },
      });
      projects.push(project);
      await installApplicationPackages(project.projectRoot, "workspace");

      await buildAndTypecheck(project.projectRoot);
    },
    commandTimeout * 2,
  );

  test(
    "从有参基类继承构造器的 bean，生成物编得过",
    async () => {
      // #350 的正向证据：依赖边按基类的参数表建起来后，emit 的 `new Target(dep)` 实参个数
      // 与基类构造器一致——回到修复前的 `new Target()`，这条用例会当场红。
      const project = await createTemporaryProject({
        "tsconfig.json": leafTsconfig(),
        src: {
          "application.ts": [
            'import { defineApplication, Injectable } from "@reforce/core";',
            'import { logging } from "@reforce/logging";',
            "",
            "export interface GreetingPort {",
            "  value(): string;",
            "}",
            "",
            "@Injectable()",
            "export class MessageRepository implements GreetingPort {",
            '  value(): string { return "hello"; }',
            "}",
            "",
            "export abstract class BaseGreetingService {",
            "  constructor(protected readonly repository: GreetingPort) {}",
            "",
            "  greet(): string {",
            "    return this.repository.value();",
            "  }",
            "}",
            "",
            "@Injectable()",
            "export class GreetingService extends BaseGreetingService {}",
            "",
            "export default defineApplication({ starters: [logging] });",
            "",
          ].join("\n"),
        },
      });
      projects.push(project);
      await installApplicationPackages(project.projectRoot, "workspace");

      await buildAndTypecheck(project.projectRoot);

      const beans = await readFile(
        join(project.projectRoot, ".reforce", "generated", "beans.ts"),
        "utf8",
      );
      expect(beans).toMatch(/create: \(resolver\) => new \w+\(resolver\.resolve<\w+>\(0\)\)/u);
    },
    commandTimeout * 2,
  );
});
