import { Command, CommanderError } from "commander";
import {
  type CliCommandName,
  createFailureEvent,
  PlainTextReporter,
  type Reporter,
} from "@/reporter";

export interface RunCliOptions {
  readonly argv?: readonly string[];
  readonly cwd?: string;
  readonly reporter?: Reporter;
}

interface ProjectOptions {
  readonly project: string;
}

interface CompileProjectOptions extends ProjectOptions {
  readonly tsconfig?: string;
}

type SelectedCommand = Exclude<CliCommandName, "cli">;

function configureProjectOption(command: Command): Command {
  return command.option(
    "--project <directory>",
    "application selection boundary, resolved from the invocation directory",
    ".",
  );
}

function configureCompileOptions(command: Command): Command {
  return configureProjectOption(command).option(
    "--tsconfig <file>",
    "leaf application tsconfig, resolved inside --project",
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
  const reporter = options.reporter ?? new PlainTextReporter();
  let result: 0 | 1 = 0;
  let selectedCommand: SelectedCommand | undefined;
  const program = new Command()
    .name("reforce")
    .description("Compile and run a Reforce application")
    .showHelpAfterError()
    .exitOverride();

  configureCompileOptions(
    program.command("build").description("build a production application"),
  ).action(async (commandOptions: CompileProjectOptions) => {
    selectedCommand = "build";
    const { runBuildCommand } = await import("@/commands/build");
    result = await runBuildCommand({
      cwd,
      projectDirectory: commandOptions.project,
      tsconfigPath: commandOptions.tsconfig,
      reporter,
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
      reporter,
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
      reporter,
    });
  });

  configureProjectOption(
    program
      .command("explain")
      .description(
        "explain a bean's selection chain from the generated manifest; starters with no bean in the manifest are not visible",
      )
      .argument("<bean>", "bean id, export name, or contract display name"),
  ).action(async (beanName: string, commandOptions: ProjectOptions) => {
    selectedCommand = "explain";
    const { runExplainCommand } = await import("@/commands/explain");
    result = await runExplainCommand({
      cwd,
      projectDirectory: commandOptions.project,
      beanName,
      reporter,
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
      reporter,
    });
  });

  try {
    await program.parseAsync(argv);
    return result;
  } catch (error) {
    return await reportCliFailure(error, selectedCommand, reporter);
  }
}
