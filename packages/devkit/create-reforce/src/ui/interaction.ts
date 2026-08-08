import { resolve } from "node:path";
import { confirm, intro, isTTY, select } from "@clack/prompts";
import pc from "picocolors";
import { DEFAULT_ENGINE, ENGINE_KEYS, ENGINES, type EngineKey } from "@/engines";
import { type CliOptions, UsageError } from "@/options";
import type { ExistingFilesStrategy } from "@/project/scaffold";
import { packageNameFromDirectory, toValidPackageName, validatePackageName } from "@/project-name";
import {
  describeUnusableDirectory,
  inspectTargetDirectory,
  normalizeDirectoryInput,
} from "@/target-directory";
import { suggestingText } from "@/ui/suggesting-text";

const DEFAULT_DIRECTORY = "my-reforce-app";
const DEFAULT_LINT = true;

// 用户按 Ctrl+C 或 Esc 时 clack 的 prompt 返回一个 symbol 而不是抛异常。
export class CancelledError extends Error {
  constructor() {
    super("已取消。");
    this.name = "CancelledError";
  }
}

// @clack/prompts 1.7.0 在运行时导出 isCancel，但它的 .d.mts 没有把这个名字放进 export
// 列表里——import 它会是编译错误。prompt 的返回类型本来就是 `T | symbol`，直接用 typeof
// 窄化既绕开了这个声明缺陷，也不比 isCancel 弱：库只会拿那一个 cancel symbol 回来。
function ensureAnswered<T extends string | boolean>(value: T | symbol): T {
  if (typeof value === "symbol") {
    throw new CancelledError();
  }
  return value;
}

export interface Answers {
  readonly directory: string;
  readonly name: string;
  readonly engine: EngineKey;
  readonly lint: boolean;
  readonly existingFiles: ExistingFilesStrategy;
}

// 只挡真正走不下去的情况。目录非空不在这里判——那要问用户怎么处理，见 askExistingFiles。
//
// 相对路径一律相对 cwd 解析，不能用裸 resolve()：那会落到进程的当前目录上，测试里和
// `--cwd` 场景下就检查到了别的地方去。
function validateDirectory(input: string | undefined, cwd: string): string | undefined {
  const normalized = normalizeDirectoryInput(input ?? "");
  if (normalized.length === 0) {
    return "请输入目录。";
  }
  return describeUnusableDirectory(resolve(cwd, normalized));
}

// 目录用带 inline 补全的输入（见 suggesting-text.ts）：灰字续写默认名，Tab / → 补全，
// 空着回车即取默认名。clack 自带的 text() 两种模式都做不到这件事。
async function askDirectory(cwd: string): Promise<string> {
  const answer = await suggestingText({
    message: "项目目录",
    suggestion: DEFAULT_DIRECTORY,
    validate: (input) => validateDirectory(input, cwd),
  });
  return normalizeDirectoryInput(ensureAnswered(answer));
}

// 目录名不合法不等于用户错了：`~/Projects/My App` 是完全正常的目录，只有 package.json 里
// 那个名字要守 npm 的规则。所以这里不报错，而是把规范化结果作为默认值再问一次。
async function askPackageName(directory: string, cwd: string): Promise<string> {
  const fromDirectory = packageNameFromDirectory(directory, cwd);
  if (validatePackageName(fromDirectory) === undefined) {
    return fromDirectory;
  }
  const answer = await suggestingText({
    message: "包名",
    suggestion: toValidPackageName(fromDirectory),
    validate: (input) => validatePackageName(input.trim()),
  });
  return ensureAnswered(answer).trim();
}

// 目录非空时给三条路，而不是直接拒绝——用户可能就是想往一个已经 git init 过、或者放了
// README 的目录里灌代码。"清空"保留 .git，见 scaffold 的 emptyDirectory。
async function askExistingFiles(directory: string): Promise<ExistingFilesStrategy> {
  const answer = await select<ExistingFilesStrategy | "cancel">({
    message: `${directory} 已存在且非空，如何处理？`,
    initialValue: "cancel",
    options: [
      { value: "cancel", label: "取消" },
      { value: "remove", label: "清空目录后继续", hint: "保留 .git" },
      { value: "keep", label: "保留现有文件，同名文件将被覆盖" },
    ],
  });
  const decision = ensureAnswered(answer);
  if (decision === "cancel") {
    throw new CancelledError();
  }
  return decision;
}

async function askEngine(): Promise<EngineKey> {
  const answer = await select<EngineKey>({
    message: "选择 web 引擎",
    initialValue: DEFAULT_ENGINE,
    options: ENGINE_KEYS.map((key) => ({
      value: key,
      label: ENGINES[key].label,
      hint: ENGINES[key].hint,
    })),
  });
  return ensureAnswered(answer);
}

async function askLint(): Promise<boolean> {
  const answer = await confirm({
    message: "启用 Biome（格式化 + lint）？",
    initialValue: DEFAULT_LINT,
  });
  return ensureAnswered(answer);
}

// 命令行已经表态的项不再问。--yes 与非交互终端（管道、CI）走同一条路：全部取默认值，
// 一个问题都不弹。
//
// stdin 和 stdout 必须都是 TTY 才算可交互：交互要读 stdin、写 stdout，缺一边就问不成。
// 只看 stdout 会在 `echo x | pnpm create reforce` 这类"输出是终端、输入是管道"的组合下
// 弹出永远等不到答案的 prompt，Node 报 unsettled top-level await 然后静默退出（实测）。
function shouldPrompt(options: CliOptions): boolean {
  return !options.yes && process.stdin.isTTY === true && isTTY(process.stdout);
}

// 非交互路径不能靠问，但也不该因为目录名不合 npm 规范就罢工：直接规范化。规范化后仍然
// 不合法（比如目录名全是标点）才是真的没法继续。
function resolveNameWithoutPrompt(directory: string, cwd: string): string {
  const fromDirectory = packageNameFromDirectory(directory, cwd);
  if (validatePackageName(fromDirectory) === undefined) {
    return fromDirectory;
  }
  const normalized = toValidPackageName(fromDirectory);
  const problem = validatePackageName(normalized);
  if (problem !== undefined) {
    throw new UsageError(`无法从目录名 "${fromDirectory}" 推出合法包名：${problem}`);
  }
  return normalized;
}

function resolveAnswersWithoutPrompt(options: CliOptions, cwd: string): Answers {
  const directory = normalizeDirectoryInput(options.directory ?? DEFAULT_DIRECTORY);
  // 非交互下绝不删用户的文件：没人能确认这个决定，就只能停下来。
  if (inspectTargetDirectory(resolve(cwd, directory)) === "not-empty") {
    throw new UsageError(`${directory} 已存在且非空。请换一个目录，或在交互模式下选择如何处理。`);
  }
  return {
    directory,
    name: resolveNameWithoutPrompt(directory, cwd),
    engine: options.engine ?? DEFAULT_ENGINE,
    lint: options.lint ?? DEFAULT_LINT,
    existingFiles: "keep",
  };
}

export async function resolveAnswers(options: CliOptions, cwd: string): Promise<Answers> {
  if (!shouldPrompt(options)) {
    return resolveAnswersWithoutPrompt(options, cwd);
  }
  intro(pc.bgCyan(pc.black(" create-reforce ")));
  const directory =
    options.directory === undefined
      ? await askDirectory(cwd)
      : normalizeDirectoryInput(options.directory);
  const existingFiles =
    inspectTargetDirectory(resolve(cwd, directory)) === "not-empty"
      ? await askExistingFiles(directory)
      : "keep";
  const name = await askPackageName(directory, cwd);
  const engine = options.engine ?? (await askEngine());
  const lint = options.lint ?? (await askLint());
  return { directory, name, engine, lint, existingFiles };
}
