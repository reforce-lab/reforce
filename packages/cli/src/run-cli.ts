import { Command, CommanderError } from "commander";
import { runBuildCommand } from "#internal/build-command";
import { runDevCommand } from "#internal/dev-command";
import {
  type CliCommandName,
  createFailureEvent,
  PlainTextReporter,
  type Reporter,
} from "#internal/reporter";
import { runStartCommand } from "#internal/start-command";

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
  try {
    await reporter.flush();
  } catch {}
  return 1;
}

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
    result = await runBuildCommand({
      cwd,
      projectDirectory: commandOptions.project,
      ...(commandOptions.tsconfig === undefined ? {} : { tsconfigPath: commandOptions.tsconfig }),
      reporter,
    });
  });

  configureCompileOptions(
    program.command("dev").description("watch and run an application"),
  ).action(async (commandOptions: CompileProjectOptions) => {
    selectedCommand = "dev";
    result = await runDevCommand({
      cwd,
      projectDirectory: commandOptions.project,
      ...(commandOptions.tsconfig === undefined ? {} : { tsconfigPath: commandOptions.tsconfig }),
      reporter,
    });
  });

  configureProjectOption(
    program.command("start").description("start a production application"),
  ).action(async (commandOptions: ProjectOptions) => {
    selectedCommand = "start";
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
