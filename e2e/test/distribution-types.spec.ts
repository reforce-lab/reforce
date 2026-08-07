import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createTemporaryProject,
  resolveNodeExecutable,
  runCommand,
  type TemporaryProject,
} from "@reforce/tooling-testing";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { installApplicationPackages } from "../support/application-packages";

// 发布类型面对 node16/nodenext 消费者的可用性（Issue #257）。
//
// 仓库自身与 fixture 应用都用 `@reforce/tooling-tsconfig/base.json` 的
// moduleResolution: Bundler，该模式不要求相对 import 带扩展名，因此 d.ts 里少写 `.js`
// 在仓库内永远不显形——typecheck、单测、IT、既有 e2e 全都是绿的。用户把 moduleResolution
// 换成 node16/nodenext 就会中招。
//
// 更麻烦的是模板里还有 skipLibCheck: true：它会把 TS2835 的报错压掉，但压不掉后果——
// d.ts 里解析不了的 re-export 会让符号在消费者侧退化，表现为「类型检查静默失效」而不是
// 报错。所以下面第二条用例断言的不是「没有报错」，而是「类型仍然拦得住错误代码」。

const typescriptRoot = fileURLToPath(new URL(".", import.meta.resolve("typescript/package.json")));
const tscEntry = join(typescriptRoot, "bin", "tsc");
const commandTimeout = 120_000;
const nodeExecutable = await resolveNodeExecutable();

// 消费者侧的判定探针：把一个函数导出赋给 number。类型正常解析时必然 TS2322；
// 一旦符号退化，这行就静默通过——这正是要防的回归。
const probeSource = `import { Injectable } from "@reforce/core";
import { createWebApplication } from "@reforce/web";

export const effectiveTypeProbe: number = createWebApplication;
export const injectableProbe = Injectable;
`;

function consumerTsconfig(skipLibCheck: boolean): string {
  return `${JSON.stringify({
    compilerOptions: {
      target: "ESNext",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      moduleDetection: "force",
      strict: true,
      types: ["node"],
      skipLibCheck,
      noEmit: true,
    },
    include: ["src"],
  })}\n`;
}

// 只保留来自 @reforce/* 发布产物的诊断：skipLibCheck: false 会连第三方 d.ts 一起检查，
// 那些与本条契约无关（测试纪律：不测第三方库行为）。
function reforceDiagnostics(output: string): readonly string[] {
  return output
    .split("\n")
    .filter((line) => line.includes("error TS") && line.includes("@reforce"));
}

async function typecheckConsumer(projectRoot: string, skipLibCheck: boolean) {
  await writeFile(join(projectRoot, "tsconfig.json"), consumerTsconfig(skipLibCheck));
  return await runCommand(
    nodeExecutable,
    [tscEntry, "--project", join(projectRoot, "tsconfig.json")],
    {
      cwd: projectRoot,
      timeout: commandTimeout,
    },
  );
}

describe.sequential("published types under nodenext resolution", () => {
  let project: TemporaryProject | undefined;

  function currentProjectRoot(): string {
    if (project === undefined) {
      throw new Error("The dist-only consumer project has not been prepared.");
    }
    return project.projectRoot;
  }

  beforeAll(async () => {
    const created = await createTemporaryProject({ src: { "probe.ts": probeSource } });
    try {
      await installApplicationPackages(created.projectRoot, "dist-only");
      project = created;
    } catch (error) {
      await created.cleanup();
      throw error;
    }
  }, commandTimeout);

  afterAll(async () => {
    await project?.cleanup();
  });

  test(
    "resolves every published declaration without extension diagnostics",
    async () => {
      const result = await typecheckConsumer(currentProjectRoot(), false);

      expect(reforceDiagnostics(`${result.stdout}${result.stderr}`)).toEqual([]);
    },
    commandTimeout,
  );

  test(
    "keeps published types effective when the consumer sets skipLibCheck",
    async () => {
      const result = await typecheckConsumer(currentProjectRoot(), true);

      // 断言具体编号而不是「有错误」：符号解析失败会报 TS2305，那同样是错误，
      // 却恰好代表类型面是坏的。只有 TS2322 证明探针那行真的被类型拦下了。
      expect(`${result.stdout}${result.stderr}`).toContain("error TS2322");
    },
    commandTimeout,
  );
});
