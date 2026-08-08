import { resolve } from "node:path";
import {
  parseRenderMode,
  type RenderMode,
  renderModeEnvironmentVariable,
  renderModeNames,
  resolveRenderMode,
  verboseEnvironmentVariable,
} from "@reforce/primitives/render-mode";
import { isInteractive } from "@reforce/primitives/terminal";
import {
  type CliCommandName,
  createFailureEvent,
  PlainTextReporter,
  type Reporter,
} from "@reforce/runtime/reporter";
import { Command, CommanderError, Option } from "commander";
import { renderBanner } from "@/banner";
import {
  type DiagnosticPolicy,
  diagnosticLevelNames,
  parseDiagnosticLevels,
} from "@/diagnostic-policy";

export interface RunCliOptions {
  readonly argv?: readonly string[];
  readonly cwd?: string;
  readonly reporter?: Reporter;
  /** CLI 自己的版本，由入口读出来传进来（banner 用）。取不到时缺席，不打假版本。 */
  readonly version?: string;
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

interface LibOptions extends CompileProjectOptions {
  readonly check?: boolean;
}

interface OpenapiOptions extends ProjectOptions {
  readonly output?: string;
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

// banner 只给产生启动输出的命令（RFC 0011 D2）。explain 的产出是 stdout 上的查询结果，
// 给它加一条招牌行只是噪音。
const bannerCommandNames = new Set(["dev", "build", "start"]);

// human 模式才打：short 给按行 grep 的脚本，json 给采集系统，两边都不需要招牌行。
function writeBanner(
  command: string,
  explicit: RenderMode | undefined,
  version: string | undefined,
): void {
  if (!bannerCommandNames.has(command)) {
    return;
  }
  const mode = resolveRenderMode({
    ...(explicit === undefined ? {} : { explicit }),
    interactive: isInteractive(process.stderr),
    audience: "tool",
    env: process.env,
  });
  if (mode !== "human") {
    return;
  }
  process.stderr.write(
    `${renderBanner({ command, ...(version === undefined ? {} : { version }) }, process.stderr)}\n`,
  );
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
  try {
    await reporter.flush();
  } catch {
    // Already on the failure-reporting path: if flushing that report also fails, no other channel
    // remains to report through, so the flush error is swallowed.
  }
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
    // banner 与 reporter 同一个流、同一次模式判定：注入了 reporter 的调用方（测试）拿到的是
    // 自己的流，往真 stderr 上打一条招牌行会污染它们的断言。
    writeBanner(actionCommand.name(), explicit, options.version);
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
    program
      .command("lib")
      .description("compile a starter library's reforce meta")
      .option(
        "--check",
        "compare the generated meta against the one on disk instead of writing it",
      ),
  ).action(async (commandOptions: LibOptions) => {
    selectedCommand = "lib";
    const { runLibCommand } = await import("@/commands/lib");
    result = await runLibCommand({
      cwd,
      projectDirectory: commandOptions.project,
      ...(commandOptions.tsconfig === undefined ? {} : { tsconfigPath: commandOptions.tsconfig }),
      reporter: currentReporter(),
      diagnosticPolicy: diagnosticPolicyOf(commandOptions),
      checkOnly: commandOptions.check === true,
    });
  });

  // meta 是唯一不碰应用、也不碰编译器的命令组：它读的是**别人要装的那个包**，所以既没有
  // --project 边界也没有 tsconfig。同一份判定另有一个不装框架的入口：npx reforce-meta-check。
  program
    .command("meta")
    .description("inspect a starter package's reforce meta")
    .command("check")
    .description("validate a starter package's reforce-meta.json against the published contract")
    .argument("[directory]", "the starter package directory", ".")
    .action(async (packageDirectory: string) => {
      selectedCommand = "meta";
      const { runMetaCheckCommand } = await import("@/commands/meta");
      result = await runMetaCheckCommand({ cwd, packageDirectory, reporter: currentReporter() });
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
    program
      .command("openapi")
      .description("export the generated route table as an OpenAPI 3.2 document (JSON)")
      .option("--output <file>", "write the document to a file instead of stdout"),
  ).action(async (commandOptions: OpenapiOptions) => {
    selectedCommand = "openapi";
    const { runOpenapiCommand } = await import("@/commands/openapi");
    result = await runOpenapiCommand({
      cwd,
      projectDirectory: commandOptions.project,
      ...(commandOptions.output === undefined ? {} : { outputPath: commandOptions.output }),
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
