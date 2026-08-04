import { PlainTextReporter } from "@reforce/runtime/reporter";
import { runDevCommand } from "@/commands/dev";

const cwd = process.argv[2];
const projectDirectory = process.argv[3];
const tsconfigPath = process.argv[4];
const releaseMode = process.argv[5];
if (!cwd || !projectDirectory) {
  throw new Error("Expected an invocation directory and project selection.");
}

// argv[4] 是位置占位符：调用方要传 argv[5] 就必须先填一个空串（见 it/commands/dev-command.spec.ts
// 的 fail-release 用例）。空串不是一个可解析的 tsconfig 路径，必须和「没传」一样折成 undefined。
const options = {
  cwd,
  projectDirectory,
  tsconfigPath: tsconfigPath || undefined,
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
