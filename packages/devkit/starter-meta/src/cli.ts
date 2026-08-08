#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { checkStarterPackage, type StarterPackageProblem } from "@/package-check";

// `npx reforce-meta-check <package dir>`：不装框架、不编译、不要应用，就能在自己的 CI 里验
// 一份 starter 的 meta（#369）。这是三层校验入口里最外的一层——里面两层是 `reforce lib --check`
// （自产字节与磁盘比对）和 `reforce meta check`（同一份判定，但走 CLI 的诊断渲染）。
//
// 退出码是唯一的机器接口：0 通过（可能带 warning），1 有 error，2 连文件都读不到。

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function describe(problem: StarterPackageProblem): string {
  return `${problem.severity}: ${problem.message}`;
}

function run(argv: readonly string[]): number {
  const target = argv[0] ?? ".";
  const packageDir = isAbsolute(target) ? target : resolve(process.cwd(), target);
  let packageJson: unknown;
  let meta: unknown;
  try {
    packageJson = readJson(join(packageDir, "package.json"));
    meta = readJson(join(packageDir, "reforce-meta.json"));
  } catch (error) {
    process.stderr.write(
      `reforce-meta-check: cannot read ${packageDir}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }
  const problems = checkStarterPackage({
    packageJson,
    meta,
    // 「包内存在」在装好的包里就等于「随包发布」；在作者的工作区里它是超集，查不出
    // 「工作区有但 files 不收」的那类遗漏——那要 npm pack 才看得见，不值得为它把本命令
    // 变成需要打包的重活。
    fileExists: (packageRelativePath) => existsSync(join(packageDir, packageRelativePath)),
  });
  for (const problem of problems) {
    process.stderr.write(`${describe(problem)}\n`);
  }
  if (problems.some((problem) => problem.severity === "error")) {
    return 1;
  }
  process.stdout.write(`reforce-meta-check: ${packageDir} is a valid starter package.\n`);
  return 0;
}

process.exitCode = run(process.argv.slice(2));
