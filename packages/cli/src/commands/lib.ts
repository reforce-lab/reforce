import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type CompilerDiagnostic,
  createCompiler,
  type LibraryGeneratedFile,
} from "@reforce/compiler";
import {
  captureFailure,
  createFailureEvent,
  type Reporter,
  reportShutdownFailure,
} from "@reforce/runtime/reporter";
import { isObject } from "radashi";
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
}

// subpath 字面量由 ADR 0004 决策 2 与 compiler 的 starter-meta schema 闸门（#145）钉死；
// compiler 根入口刻意只在运行时暴露 createCompiler，这里不经 import 复用常量。
const expectedSubpathTargets: readonly {
  readonly subpath: string;
  readonly target: string;
}[] = [{ subpath: "./reforce-meta", target: "./reforce-meta.json" }];

function reportCompilerDiagnostics(
  reporter: Reporter,
  phase: "project" | "compiler",
  diagnostics: readonly CompilerDiagnostic[],
): void {
  for (const diagnostic of diagnostics) {
    reporter.report({ kind: "diagnostic", command: "lib", phase, diagnostic });
  }
}

// 接受 exports 的两种直写形态：字符串目标，或 default 条件指向目标的条件对象。其余形态
// （pattern、数组 fallback、深嵌条件）解析结果依赖包管理器语义，一律要求作者改成直写。
function subpathReaches(target: unknown, expected: string): boolean {
  if (typeof target === "string") {
    return target === expected;
  }
  return isObject(target) && Reflect.get(target, "default") === expected;
}

async function findExportsProblem(projectRoot: string): Promise<string | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
  } catch {
    return "package.json cannot be read as JSON.";
  }
  const exports = isObject(parsed) ? Reflect.get(parsed, "exports") : undefined;
  if (!isObject(exports)) {
    return "package.json must declare an exports map.";
  }
  for (const { subpath, target } of expectedSubpathTargets) {
    if (!subpathReaches(Reflect.get(exports, subpath), target)) {
      return `exports must map "${subpath}" to "${target}".`;
    }
  }
  return undefined;
}

async function writeGeneratedFile(projectRoot: string, file: LibraryGeneratedFile): Promise<void> {
  const destination = join(projectRoot, file.path);
  const staging = `${destination}.reforce-staging`;
  await writeFile(staging, file.content, "utf8");
  await renameWithWindowsRetry(staging, destination);
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
        for (const file of compilation.files) {
          await writeGeneratedFile(projectRoot, file);
        }
        const exportsProblem = await findExportsProblem(projectRoot);
        if (exportsProblem === undefined) {
          options.reporter.report({
            kind: "success",
            command: "lib",
            message: `Generated starter meta for ${compilation.packageName}.`,
          });
          exitCode = 0;
        } else {
          options.reporter.report(
            createFailureEvent({
              command: "lib",
              phase: "project",
              fallbackCode: "PACKAGE_EXPORTS_INVALID",
              message: `${compilation.packageName} ${exportsProblem}`,
              cause: undefined,
            }),
          );
        }
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
