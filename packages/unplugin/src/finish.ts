import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type CompilerDiagnostic,
  createCompiler,
  type LibraryGeneratedFile,
} from "@reforce/compiler";
import { toPortablePath } from "@reforce/primitives";
import { publint } from "publint";
import { formatMessage } from "publint/utils";

// 作者侧收尾（ADR 0004 决策 4，#120/#147）：打包器写完产物后跑库模式编译，meta 与注册 handle
// 写进作者配置的输出目录，随后补/校正 exports 的 subpath——物理位置由输出目录决定，subpath
// 是唯一契约。发布产物校验直接用 publint（error 级即失败），不自造校验器。

export interface ReforceStarterOptions {
  /** 库项目根（含 package.json 与 leaf tsconfig）；默认取进程工作目录。 */
  readonly projectDirectory?: string;
  /** 显式选择 leaf tsconfig，相对 projectDirectory 解析。 */
  readonly tsconfigPath?: string;
  /** meta 与注册 handle 的写入目录，相对项目根；默认 "dist"。 */
  readonly outputDirectory?: string;
  /** 关闭 publint 发布校验；默认开启。 */
  readonly publint?: boolean;
}

// subpath 字面量由 ADR 0004 决策 2 与 compiler 的 starter-meta schema 闸门（#145）钉死；
// compiler 根入口刻意只在运行时暴露 createCompiler，这里不经 import 复用常量。
const starterMetaSubpath = "./reforce-meta";
const starterHandleSubpath = "./reforce";

function renderDiagnostic(diagnostic: CompilerDiagnostic): string {
  const location = diagnostic.sourceSpan
    ? ` ${diagnostic.sourceSpan.fileId}:${diagnostic.sourceSpan.start.line + 1}:${diagnostic.sourceSpan.start.character + 1}`
    : "";
  const help = diagnostic.help === undefined ? "" : ` (${diagnostic.help})`;
  return `[${diagnostic.code}]${location} ${diagnostic.message}${help}`;
}

function failWith(step: string, diagnostics: readonly CompilerDiagnostic[]): never {
  const lines = diagnostics.map(renderDiagnostic).join("\n");
  throw new Error(`reforce starter ${step} failed:\n${lines}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exportTarget(projectRoot: string, outputDirectory: string, file: string): string {
  return `./${toPortablePath(path.relative(projectRoot, path.join(outputDirectory, file)))}`;
}

interface PatchedExports {
  readonly changed: boolean;
  readonly content: string;
}

function patchExportsContent(
  raw: string,
  projectRoot: string,
  outputDirectory: string,
  files: readonly LibraryGeneratedFile[],
): PatchedExports {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || !isRecord(parsed.exports)) {
    // compileLibrary 已把缺失 exports 当 INVALID_LIBRARY_PACKAGE 拦下，这里只处理成功编译后的包。
    throw new Error("package.json lost its exports map between compilation and patching.");
  }
  const exports: Record<string, unknown> = { ...parsed.exports };
  const target = (file: LibraryGeneratedFile["path"]): string => {
    const generated = files.find((candidate) => candidate.path === file);
    if (generated === undefined) {
      throw new Error(`Library compilation produced no ${file}.`);
    }
    return exportTarget(projectRoot, outputDirectory, generated.path);
  };
  const desired: Record<string, unknown> = {
    [starterHandleSubpath]: {
      types: target("reforce.d.ts"),
      default: target("reforce.js"),
    },
    [starterMetaSubpath]: target("reforce-meta.json"),
  };
  let changed = false;
  for (const [subpath, value] of Object.entries(desired)) {
    if (JSON.stringify(exports[subpath]) !== JSON.stringify(value)) {
      exports[subpath] = value;
      changed = true;
    }
  }
  if (!changed) {
    return { changed, content: raw };
  }
  const indent = /\n([ \t]+)"/.exec(raw)?.[1] ?? "  ";
  const content = `${JSON.stringify({ ...parsed, exports }, undefined, indent)}\n`;
  return { changed, content };
}

async function runPublint(projectRoot: string): Promise<void> {
  // pack: false——publint 默认会拉起包管理器 pack 来模拟发布文件集，构建收尾钩子里反复
  // spawn 又慢又不稳（Windows CI 实测 EBUSY，PR #156）。纯 fs 校验已覆盖 exports/main 目标
  // 缺失这类 meta subpath 配置事故；files 字段漏发 dist 属发布前检查，交给作者跑 publint CLI。
  const { messages, pkg } = await publint({ pkgDir: projectRoot, level: "error", pack: false });
  const errors = messages.filter((message) => message.type === "error");
  if (errors.length === 0) {
    return;
  }
  const lines = errors.map(
    (message) => formatMessage(message, pkg, { color: false }) ?? message.code,
  );
  throw new Error(`reforce starter publint failed:\n${lines.join("\n")}`);
}

export async function finishStarterBuild(options: ReforceStarterOptions): Promise<void> {
  const projectDirectory = path.resolve(options.projectDirectory ?? process.cwd());
  const compiler = createCompiler();
  const resolution = await compiler.resolveLibraryProject({
    projectDirectory,
    ...(options.tsconfigPath === undefined ? {} : { tsconfigPath: options.tsconfigPath }),
  });
  if (resolution.status === "failure") {
    failWith("project resolution", resolution.diagnostics);
  }
  const compilation = await compiler.compileLibrary({ project: resolution.project });
  if (compilation.status === "failure") {
    failWith("library compilation", compilation.diagnostics);
  }
  const projectRoot = resolution.project.projectRoot;
  const outputDirectory = path.resolve(projectRoot, options.outputDirectory ?? "dist");
  await mkdir(outputDirectory, { recursive: true });
  for (const file of compilation.files) {
    await writeFile(path.join(outputDirectory, file.path), file.content, "utf8");
  }
  const packageJsonPath = path.join(projectRoot, "package.json");
  const raw = await readFile(packageJsonPath, "utf8");
  const patched = patchExportsContent(raw, projectRoot, outputDirectory, compilation.files);
  if (patched.changed) {
    await writeFile(packageJsonPath, patched.content, "utf8");
  }
  if (options.publint !== false) {
    await runPublint(projectRoot);
  }
}
