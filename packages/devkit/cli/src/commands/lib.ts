import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type CompilerDiagnostic,
  createCompiler,
  type LibraryGeneratedFile,
} from "@reforce/compiler";
import type { CliFailureCode } from "@reforce/runtime/error-codes";
import {
  captureFailure,
  createFailureEvent,
  type Reporter,
  reportShutdownFailure,
} from "@reforce/runtime/reporter";
import { findExportsProblem } from "@reforce/starter-meta";
import {
  applyDiagnosticPolicy,
  type DiagnosticPolicy,
  deniedByDiagnosticPolicy,
  permissiveDiagnosticPolicy,
} from "@/diagnostic-policy";
import { reportDiagnostics } from "@/diagnostic-reporting";
import { renameWithWindowsRetry } from "@/project/windows-rename-retry";

// reforce lib（ADR 0004 决策 1/4，#120/#147）：库模式编译的 CLI 面。产物写在包根——与 M1 起
// 钉死的 starter 包缺省布局一致（exports "./reforce-meta" -> "./reforce-meta.json"）；要写进
// 打包器输出目录的作者走 unplugin 插件。exports subpath 是唯一契约，这里只校验不改写：改写
// 作者 package.json 是插件的职责，CLI 把缺失/错位当失败报出来。

export interface LibCommandOptions {
  readonly cwd: string;
  readonly projectDirectory: string;
  readonly tsconfigPath?: string;
  readonly reporter: Reporter;
  readonly diagnosticPolicy?: DiagnosticPolicy;
  /**
   * 只比对不写盘（#369）：CI 用它守「meta 与源码同步」，本地照常写。
   *
   * 它顺带修掉一处顺序缺陷——exports 校验此前跑在写盘**之后**，作者拿到一份写好了却接不上的
   * 产物；`--check` 本就不许写盘，那道校验只能前移，两种模式因此共用同一个顺序。
   */
  readonly checkOnly?: boolean;
}

function reportCompilerDiagnostics(
  reporter: Reporter,
  phase: "project" | "compiler",
  diagnostics: readonly CompilerDiagnostic[],
): void {
  reportDiagnostics({ reporter, command: "lib", phase, diagnostics });
}

// exports 的判定住在 @reforce/starter-meta（#369）：`reforce meta check` 与外部作者的
// `npx reforce-meta-check` 用的是同一份，三个入口不会各自漂。
async function exportsProblemAt(projectRoot: string): Promise<string | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
  } catch {
    return "package.json cannot be read as JSON.";
  }
  return findExportsProblem(parsed);
}

async function writeGeneratedFile(projectRoot: string, file: LibraryGeneratedFile): Promise<void> {
  const destination = join(projectRoot, file.path);
  const staging = `${destination}.reforce-staging`;
  await writeFile(staging, file.content, "utf8");
  await renameWithWindowsRetry(staging, destination);
}

type LibraryCompilation = Awaited<ReturnType<ReturnType<typeof createCompiler>["compileLibrary"]>>;
type LibraryCompilationSuccess = Extract<LibraryCompilation, { readonly status: "success" }>;

// 磁盘上的字节与本次编译的字节不一致的那些文件。读不到当成不一致：没有 meta 与 meta 过期，
// 对 `--check` 是同一个答案。
async function driftedFiles(
  projectRoot: string,
  files: readonly LibraryGeneratedFile[],
): Promise<readonly string[]> {
  const drifted: string[] = [];
  for (const file of files) {
    const onDisk = await readFile(join(projectRoot, file.path), "utf8").catch(() => undefined);
    if (onDisk !== file.content) {
      drifted.push(file.path);
    }
  }
  return drifted;
}

function reportFailure(reporter: Reporter, code: CliFailureCode, message: string): 1 {
  reporter.report(
    createFailureEvent({
      command: "lib",
      phase: "project",
      fallbackCode: code,
      message,
      cause: undefined,
    }),
  );
  return 1;
}

// 落盘与上报独立成段：runLibCommand 只说「解析 → 编译 → 交给它 → 收尾」，成功分支里的
// 诊断策略、写文件、exports 校验三件事不该和外层的失败聚合挤在同一个抽象层级上。
async function commitLibraryOutput(input: {
  readonly projectRoot: string;
  readonly compilation: LibraryCompilationSuccess;
  readonly reporter: Reporter;
  readonly policy: DiagnosticPolicy;
  readonly checkOnly: boolean;
}): Promise<0 | 1> {
  // 成功路径也要遍历诊断（RFC 0011 OM2，#242）：编译成功不再等于零诊断。
  const warnings = applyDiagnosticPolicy(input.policy, input.compilation.diagnostics);
  reportCompilerDiagnostics(input.reporter, "compiler", warnings);
  const packageName = input.compilation.packageName;
  const exportsProblem = await exportsProblemAt(input.projectRoot);
  if (exportsProblem !== undefined) {
    return reportFailure(
      input.reporter,
      "PACKAGE_EXPORTS_INVALID",
      `${packageName} ${exportsProblem}`,
    );
  }
  if (input.checkOnly) {
    const drifted = await driftedFiles(input.projectRoot, input.compilation.files);
    if (drifted.length > 0) {
      return reportFailure(
        input.reporter,
        "STARTER_META_OUT_OF_DATE",
        `${packageName} has ${drifted.join(", ")} out of date; run reforce lib to regenerate.`,
      );
    }
  } else {
    for (const file of input.compilation.files) {
      await writeGeneratedFile(input.projectRoot, file);
    }
  }
  input.reporter.report({
    kind: "success",
    command: "lib",
    message: input.checkOnly
      ? `Starter meta for ${packageName} is up to date.`
      : `Generated starter meta for ${packageName}.`,
  });
  // 产物照常落盘：图是完整的。非零退出只是给 CI 的闸门信号。
  return deniedByDiagnosticPolicy(input.policy, warnings) ? 1 : 0;
}

export async function runLibCommand(options: LibCommandOptions): Promise<0 | 1> {
  const compiler = createCompiler();
  let exitCode: 0 | 1 = 1;
  const primaryFailures: unknown[] = [];
  const shutdownFailures: unknown[] = [];
  try {
    const resolution = await compiler.resolveLibraryProject({
      projectDirectory: resolve(options.cwd, options.projectDirectory),
      ...(options.tsconfigPath === undefined ? {} : { tsconfigPath: options.tsconfigPath }),
    });
    if (resolution.status === "failure") {
      reportCompilerDiagnostics(options.reporter, "project", resolution.diagnostics);
    } else {
      const projectRoot = resolution.project.projectRoot;
      const compilation = await compiler.compileLibrary({ project: resolution.project });
      if (compilation.status === "failure") {
        reportCompilerDiagnostics(options.reporter, "compiler", compilation.diagnostics);
      } else {
        exitCode = await commitLibraryOutput({
          projectRoot,
          compilation,
          reporter: options.reporter,
          policy: options.diagnosticPolicy ?? permissiveDiagnosticPolicy,
          checkOnly: options.checkOnly === true,
        });
      }
    }
  } catch (error) {
    primaryFailures.push(error);
    options.reporter.report(
      createFailureEvent({
        command: "lib",
        phase: "build",
        fallbackCode: "BUILD_FAILED",
        message: "Library build failed.",
        cause: error,
      }),
    );
  }

  // 关掉 checker 会话的 tsgo 子进程(RFC 0012 S1,#273);没查询过 checker 时是无进程 no-op。
  await captureFailure(async () => compiler.close(), shutdownFailures);
  await captureFailure(() => options.reporter.flush(), shutdownFailures);
  if (shutdownFailures.length > 0) {
    await reportShutdownFailure({
      reporter: options.reporter,
      command: "lib",
      errors: [...primaryFailures, ...shutdownFailures],
    });
    return 1;
  }
  return exitCode;
}
