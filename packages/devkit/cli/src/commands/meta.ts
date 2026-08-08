import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CompilerDiagnostic } from "@reforce/compiler";
import { createFailureEvent, type Reporter } from "@reforce/runtime/reporter";
import { checkStarterPackage, findExportsProblem } from "@reforce/starter-meta";
import { reportDiagnostics } from "@/diagnostic-reporting";

// `reforce meta check <dir>`（#369）：不编译、不要应用，只读 package.json + reforce-meta.json，
// 回答「这个包作为 starter 装到别人的应用里能不能接上」。
//
// 判定与 `npx reforce-meta-check`（@reforce/starter-meta 的 bin）逐字同一份——差别只在这里走
// CLI 的诊断渲染，用得上 --error-format=json 与 reforce explain。装了框架的人用这条，没装的
// 用那条，两条不会给出不同的答案。

export interface MetaCheckCommandOptions {
  readonly cwd: string;
  readonly packageDirectory: string;
  readonly reporter: Reporter;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function runMetaCheckCommand(options: MetaCheckCommandOptions): Promise<0 | 1> {
  const packageDir = resolve(options.cwd, options.packageDirectory);
  let packageJson: unknown;
  let meta: unknown;
  try {
    packageJson = await readJson(join(packageDir, "package.json"));
    meta = await readJson(join(packageDir, "reforce-meta.json"));
  } catch (error) {
    options.reporter.report(
      createFailureEvent({
        command: "meta",
        phase: "project",
        fallbackCode: "ARTIFACT_INVALID",
        message: `${packageDir} has no readable package.json and reforce-meta.json pair.`,
        cause: error,
      }),
    );
    await options.reporter.flush();
    return 1;
  }
  // exports 单独走失败事件而不是诊断：它不是 meta 字节的毛病，而是包的交付契约，与
  // `reforce lib` 报的是同一个码，用户在两条命令下看到同一句话。
  const exportsProblem = findExportsProblem(packageJson);
  if (exportsProblem !== undefined) {
    options.reporter.report(
      createFailureEvent({
        command: "meta",
        phase: "project",
        fallbackCode: "PACKAGE_EXPORTS_INVALID",
        message: exportsProblem,
        cause: undefined,
      }),
    );
    await options.reporter.flush();
    return 1;
  }
  const problems = checkStarterPackage({
    packageJson,
    meta,
    fileExists: (packageRelativePath) => existsSync(join(packageDir, packageRelativePath)),
  });
  // 这条命令不编译，所以没有 span 可给：位置信息在 meta 里，而 meta 本身正是被质疑的东西。
  const diagnostics: readonly CompilerDiagnostic[] = problems.map((problem) => ({
    kind: "compiler" as const,
    code: "INVALID_STARTER_META" as const,
    severity: problem.severity,
    message: problem.message,
    related: [],
  }));
  reportDiagnostics({ reporter: options.reporter, command: "meta", phase: "project", diagnostics });
  const failed = problems.some((problem) => problem.severity === "error");
  if (!failed) {
    options.reporter.report({
      kind: "success",
      command: "meta",
      message: `${packageDir} is a valid starter package.`,
    });
  }
  await options.reporter.flush();
  return failed ? 1 : 0;
}
