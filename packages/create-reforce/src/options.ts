import { parseArgs } from "node:util";
import { ENGINE_KEYS, type EngineKey, isEngineKey } from "@/engines";

// 用户输入错误（区别于内部缺陷）：入口只把 message 打给用户，不带堆栈。
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface CliOptions {
  readonly directory: string | undefined;
  readonly engine: EngineKey | undefined;
  // 三态：undefined 表示命令行没表态，留给交互问。
  readonly lint: boolean | undefined;
  readonly yes: boolean;
  readonly help: boolean;
  readonly version: boolean;
}

// parseArgs 不认 `--no-<flag>` 取反（Node 的实现里没有 negation 语义），所以 no-lint 必须
// 单列成一个 boolean 选项，再在下面归并成三态。
const PARSE_OPTIONS = {
  engine: { type: "string" },
  lint: { type: "boolean" },
  "no-lint": { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean" },
} as const;

function resolveLint(lint: boolean | undefined, noLint: boolean | undefined): boolean | undefined {
  if (lint === true && noLint === true) {
    throw new UsageError("--lint 与 --no-lint 不能同时使用。");
  }
  if (lint === true) {
    return true;
  }
  if (noLint === true) {
    return false;
  }
  return undefined;
}

function resolveEngine(engine: string | undefined): EngineKey | undefined {
  if (engine === undefined) {
    return undefined;
  }
  if (!isEngineKey(engine)) {
    throw new UsageError(`未知的 --engine "${engine}"，可选值：${ENGINE_KEYS.join("、")}。`);
  }
  return engine;
}

// parseArgs 在 strict 模式下对未知选项抛 TypeError。返回类型交给推导——显式标注要把
// allowPositionals 一起写进类型参数才不会把 positionals 推成空元组。
function parseOrThrow(args: readonly string[]) {
  try {
    return parseArgs({ args: [...args], options: PARSE_OPTIONS, allowPositionals: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : "无法解析命令行参数。");
  }
}

export function parseCliOptions(args: readonly string[]): CliOptions {
  const { values, positionals } = parseOrThrow(args);
  if (positionals.length > 1) {
    throw new UsageError(
      `只接受一个目标目录，收到 ${positionals.length} 个：${positionals.join(" ")}。`,
    );
  }
  return {
    directory: positionals[0],
    engine: resolveEngine(values.engine),
    lint: resolveLint(values.lint, values["no-lint"]),
    yes: values.yes ?? false,
    help: values.help ?? false,
    version: values.version ?? false,
  };
}
