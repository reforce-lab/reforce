// 渲染模式解析（RFC 0011 D1，#242）：诊断与失败有三种呈现——human 给终端前的人，short 给
// 按行 grep 的脚本，json 给日志聚合。模式必须在 reporter 构造时定死：同一次运行里换模式会让
// 上下两半输出对不上。
//
// 跨进程只能靠 env：dev/production 子进程的 stdio 是 inherit fd2，父子各自构造 reporter，IPC 上
// 没有 reporter 事件，所以父进程解析出的模式要写进子进程 env 才能传下去。
export type RenderMode = "human" | "short" | "json";

// tool = CLI 自己说话，application = 用户应用在运行期说话。两者在非 TTY 下的缺省不同：
// 前者被 CI 日志按行读（short 保住 grep），后者被日志系统收走（json 保住结构）。
export type RenderAudience = "tool" | "application";

export const renderModeEnvironmentVariable = "REFORCE_ERROR_FORMAT";

// 表驱动而不是 `as RenderMode`：env 与 argv 上的值是任意字符串，查表命中才是 RenderMode，
// 这样解析函数不需要未经校验的断言。
const renderModeByName = new Map<string, RenderMode>([
  ["human", "human"],
  ["short", "short"],
  ["json", "json"],
]);

export const renderModeNames: readonly string[] = [...renderModeByName.keys()];

export function parseRenderMode(value: string | undefined): RenderMode | undefined {
  return value === undefined ? undefined : renderModeByName.get(value);
}

export interface RenderModeInput {
  /** --error-format 之类的显式指定，优先于其余一切。 */
  readonly explicit?: RenderMode;
  // 取的是布尔而不是流本身：TTY 判定要读 Writable 上没有声明的 isTTY，那层运行时检查归
  // terminal.isInteractive；解析规则本身留成纯查表，四个维度可以直接列表驱动地测。
  readonly interactive: boolean;
  readonly audience: RenderAudience;
  readonly env: Readonly<Record<string, string | undefined>>;
}

// 栈帧折叠的展开开关（RFC 0011 D6，#242）。与 --error-format 同一套跨进程办法：写进 env，
// 子进程各自读——它们的 stdio 是 inherit fd2，IPC 上没有 reporter 事件传得下去。
export const verboseEnvironmentVariable = "REFORCE_VERBOSE";

export interface VerboseInput {
  /** --verbose 之类的显式指定，优先于 env。 */
  readonly explicit?: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
}

// 只认 "1" 与 "true"：env 上的任意字符串（含空串）都不该被当成"开"。同 renderMode，
// 无法识别的值静默落回关闭，一个手滑的值不该改变整棵进程树的输出详略。
export function resolveVerbose(input: VerboseInput): boolean {
  if (input.explicit !== undefined) {
    return input.explicit;
  }
  const value = input.env[verboseEnvironmentVariable];
  return value === "1" || value === "true";
}

export function resolveRenderMode(input: RenderModeInput): RenderMode {
  if (input.explicit !== undefined) {
    return input.explicit;
  }
  // env 上的无法识别值静默落回自动判定，而不是抛错：这条 env 会被继承进任意子进程，
  // 一个手滑的值不该让整棵进程树起不来。
  const fromEnvironment = parseRenderMode(input.env[renderModeEnvironmentVariable]);
  if (fromEnvironment !== undefined) {
    return fromEnvironment;
  }
  if (input.interactive) {
    return "human";
  }
  return input.audience === "tool" ? "short" : "json";
}
