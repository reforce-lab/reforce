import { resolve } from "node:path";
import {
  parseRenderMode,
  renderModeEnvironmentVariable,
  renderModeNames,
  verboseEnvironmentVariable,
} from "@reforce/runtime/render-mode";
import {
  type CliCommandName,
  createFailureEvent,
  PlainTextReporter,
  type Reporter,
} from "@reforce/runtime/reporter";
import { Command, CommanderError, Option } from "commander";
import {
  type DiagnosticPolicy,
  diagnosticLevelNames,
  parseDiagnosticLevels,
} from "@/diagnostic-policy";

export interface RunCliOptions {
  readonly argv?: readonly string[];
  readonly cwd?: string;
  readonly reporter?: Reporter;
}

interface ProjectOptions {
  readonly project: string;
}

interface DiagnosticOptions {
  readonly denyWarnings?: boolean;
  readonly diagnosticLevel?: readonly string[];
}

interface CompileProjectOptions extends ProjectOptions, DiagnosticOptions {
  readonly tsconfig?: string;
}

type SelectedCommand = Exclude<CliCommandName, "cli">;

function configureProjectOption(command: Command): Command {
  return command
    .option(
      "--project <directory>",
      "application selection boundary, resolved from the invocation directory",
      ".",
    )
    .addOption(
      // 逐命令而不是全局：commander 的全局选项要写在子命令名之前（`reforce --error-format=json
      // build`），而人手打出来的顺序总是 `reforce build --error-format=json`。choices 让非法值
      // 变成一条正常的 argv 用法错误，而不是被静默当成「没指定」。
      new Option(
        "--error-format <mode>",
        "how diagnostics and failures are rendered; defaults to human on a terminal, short when piped",
      ).choices([...renderModeNames]),
    )
    .option("--verbose", "show the node and reforce stack frames that are folded away by default");
}

function collectRepeated(value: string, previous: readonly string[]): readonly string[] {
  return [...previous, value];
}

// 只有跑编译器的命令才有诊断可调级；explain/start 不编译，挂上去只会是一条永远无效的选项。
function configureDiagnosticOptions(command: Command): Command {
  return command
    .option(
      "--deny-warnings",
      "exit non-zero when any warning is reported; generated output is still written",
    )
    .option(
      `--diagnostic-level <CODE=${diagnosticLevelNames.join("|")}>`,
      "raise, lower or silence one diagnostic code; repeatable. Only warnings can be re-levelled: an error means the analysis could not produce a complete graph",
      collectRepeated,
      [],
    );
}

function configureCompileOptions(command: Command): Command {
  return configureDiagnosticOptions(configureProjectOption(command)).option(
    "--tsconfig <file>",
    "leaf application tsconfig, resolved inside --project",
  );
}

function diagnosticPolicyOf(commandOptions: DiagnosticOptions): DiagnosticPolicy {
  return {
    denyWarnings: commandOptions.denyWarnings === true,
    levels: parseDiagnosticLevels(commandOptions.diagnosticLevel ?? []),
  };
}

async function reportCliFailure(
  error: unknown,
  selectedCommand: SelectedCommand | undefined,
  reporter: Reporter,
): Promise<0 | 1> {
  if (error instanceof CommanderError && error.code === "commander.helpDisplayed") {
    return 0;
  }
  const command = error instanceof CommanderError ? "cli" : (selectedCommand ?? "cli");
  const commandFailure = command !== "cli";
  let message = error instanceof Error ? error.message : "Invalid command line arguments.";
  if (commandFailure) {
    message = `${command} command failed outside its shutdown boundary.`;
  }
  reporter.report(
    createFailureEvent({
      command,
      phase: commandFailure ? "shutdown" : "argv",
      fallbackCode: commandFailure ? "SHUTDOWN_FAILED" : "CLI_USAGE_ERROR",
      message,
      cause: error,
    }),
  );
  // Already on the failure-reporting path: if flushing that report also fails, no other channel
  // remains to report through, so the flush error is swallowed.
  try {
    await reporter.flush();
  } catch {}
  return 1;
}

// 命令实现按需加载：build/dev 会把 bundler 与 compiler 拉进模块图（本机实测 dist 下 import
// commands/build.js 约 83ms，本模块自身约 17ms），而 `reforce start`、`--help` 和任何 argv 报错都
// 用不到它们。静态 import 会让这三条路径都先付这份代价，而 Commander 在进入 action 之前就已经确定
// 了要跑哪个命令。
export async function runCli(options: RunCliOptions = {}): Promise<0 | 1> {
  const argv = [...(options.argv ?? process.argv)];
  const cwd = options.cwd ?? process.cwd();
  // reporter 惰性构造：--error-format 和 --project 要到 parseAsync 进入 action 之后才可知，
  // 而 reporter 的渲染模式与源码根在构造时就定死。注入的 reporter（测试）恒优先。
  let reporter = options.reporter;
  const currentReporter = (): Reporter => (reporter ??= new PlainTextReporter());
  let result: 0 | 1 = 0;
  let selectedCommand: SelectedCommand | undefined;
  const program = new Command()
    .name("reforce")
    .description("Compile and run a Reforce application")
    .showHelpAfterError()
    .exitOverride();

  program.hook("preAction", (_program, actionCommand) => {
    // commander 的 opts() 是 Record<string, any>，窄成 unknown 再逐个判型，避免 any 顺着
    // 构造参数扩散出去。
    const values: Readonly<Record<string, unknown>> = actionCommand.opts();
    const explicit = parseRenderMode(
      typeof values.errorFormat === "string" ? values.errorFormat : undefined,
    );
    // 栈帧折叠的展开开关（RFC 0011 D6）：与 --error-format 同一条跨进程通道。只在开启时写
    // env——不写等同于关闭，而写一个 "0" 反而会盖掉调用方自己设的 REFORCE_VERBOSE。
    const verbose = values.verbose === true;
    if (verbose) {
      process.env[verboseEnvironmentVariable] = "1";
    }
    if (explicit !== undefined) {
      // 子进程的 stdio 是 inherit fd2，父子各自构造 reporter，IPC 上没有 reporter 事件——
      // 显式模式只能靠 env 传下去。未显式指定时不必传：子进程的 fd2 就是父进程那一个，
      // 它自己判 TTY 会得到同样的结论。
      process.env[renderModeEnvironmentVariable] = explicit;
    }
    if (options.reporter !== undefined) {
      return;
    }
    reporter = new PlainTextReporter({
      ...(explicit === undefined ? {} : { mode: explicit }),
      ...(verbose ? { verbose } : {}),
      // human 模式取源码切片的基准。--project 是选择边界，编译器解析出的 projectRoot 在
      // 单应用与 monorepo 子目录两种布局下都与它一致；万一不一致，读文件失败会降级成
      // 只打位置行，不会渲染出错误的代码。
      sourceRoot: resolve(cwd, typeof values.project === "string" ? values.project : "."),
    });
  });

  configureCompileOptions(
    program.command("build").description("build a production application"),
  ).action(async (commandOptions: CompileProjectOptions) => {
    selectedCommand = "build";
    const { runBuildCommand } = await import("@/commands/build");
    result = await runBuildCommand({
      cwd,
      projectDirectory: commandOptions.project,
      tsconfigPath: commandOptions.tsconfig,
      reporter: currentReporter(),
      diagnosticPolicy: diagnosticPolicyOf(commandOptions),
    });
  });

  configureCompileOptions(
    program.command("dev").description("watch and run an application"),
  ).action(async (commandOptions: CompileProjectOptions) => {
    selectedCommand = "dev";
    const { runDevCommand } = await import("@/commands/dev");
    result = await runDevCommand({
      cwd,
      projectDirectory: commandOptions.project,
      tsconfigPath: commandOptions.tsconfig,
      reporter: currentReporter(),
      diagnosticPolicy: diagnosticPolicyOf(commandOptions),
    });
  });

  configureCompileOptions(
    program.command("lib").description("compile a starter library's reforce meta"),
  ).action(async (commandOptions: CompileProjectOptions) => {
    selectedCommand = "lib";
    const { runLibCommand } = await import("@/commands/lib");
    result = await runLibCommand({
      cwd,
      projectDirectory: commandOptions.project,
      ...(commandOptions.tsconfig === undefined ? {} : { tsconfigPath: commandOptions.tsconfig }),
      reporter: currentReporter(),
      diagnosticPolicy: diagnosticPolicyOf(commandOptions),
    });
  });

  configureProjectOption(
    program
      .command("explain")
      .description(
        "explain a diagnostic code, a bean's selection chain from the generated manifest, or a route's handling chain from the generated route table; starters with no bean in the manifest are not visible",
      )
      .argument(
        "<query>",
        'diagnostic code, bean id, export name, contract display name, or a route query ("/path" or "GET /path")',
      ),
  ).action(async (beanName: string, commandOptions: ProjectOptions) => {
    selectedCommand = "explain";
    const { runExplainCommand } = await import("@/commands/explain");
    result = await runExplainCommand({
      cwd,
      projectDirectory: commandOptions.project,
      beanName,
      reporter: currentReporter(),
    });
  });

  configureProjectOption(
    program.command("start").description("start a production application"),
  ).action(async (commandOptions: ProjectOptions) => {
    selectedCommand = "start";
    const { runStartCommand } = await import("@/commands/start");
    result = await runStartCommand({
      cwd,
      projectDirectory: commandOptions.project,
      reporter: currentReporter(),
    });
  });

  try {
    await program.parseAsync(argv);
    return result;
  } catch (error) {
    return await reportCliFailure(error, selectedCommand, currentReporter());
  }
}
