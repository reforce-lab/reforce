import { runDevCommand } from "#internal/dev-command";
import { PlainTextReporter } from "#internal/reporter";

const cwd = process.argv[2];
const projectDirectory = process.argv[3];
const tsconfigPath = process.argv[4];
const releaseMode = process.argv[5];
if (!cwd || !projectDirectory) {
  throw new Error("Expected an invocation directory and project selection.");
}

const options = {
  cwd,
  projectDirectory,
  ...(tsconfigPath ? { tsconfigPath } : {}),
  reporter: new PlainTextReporter(),
};
process.exitCode =
  releaseMode === "fail-release"
    ? await runDevCommand(options, {
        async releaseLease(lease) {
          await lease.release();
          throw new Error("injected lease release failure");
        },
      })
    : await runDevCommand(options);
