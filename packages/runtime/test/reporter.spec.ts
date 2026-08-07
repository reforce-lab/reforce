import { Writable } from "node:stream";
import { UnregisteredBeanTargetError } from "@reforce/core";
import { normalizeTerminalOutput } from "@reforce/tooling-testing";
import { describe, expect, test } from "vitest";
import {
  createFailureEvent,
  PlainTextReporter,
  type PlainTextReporterOptions,
  type ReportedDiagnostic,
  type Reporter,
} from "@/reporter";

class RecordingWritable extends Writable {
  readonly chunks: string[] = [];

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(chunk.toString("utf8"));
    callback();
  }
}

// 覆写公开 write 而非 _write：Writable 的 _write 回调收到错误后会 autoDestroy 自己，
// 后续 write 根本到不了 _write，无法表达「写失败后仍能继续写」的 sink（process.stderr
// 在 EPIPE 之后就是这种行为）。reporter 只依赖 write(chunk, callback)，这里测的正是
// 它依赖的那层契约（#25）。
class FirstWriteFailsWritable extends Writable {
  readonly chunks: string[] = [];
  readonly failure = new Error("stderr write failed");
  private writeCount = 0;

  override write(
    chunk: string,
    encoding?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean {
    const done = typeof encoding === "function" ? encoding : callback;
    this.writeCount += 1;
    if (this.writeCount === 1) {
      done?.(this.failure);
      return true;
    }
    this.chunks.push(chunk);
    done?.(null);
    return true;
  }
}

describe("plain text reporter", () => {
  test("writes stable non-interactive output without ANSI or prompts", async () => {
    const output = new RecordingWritable();
    const reporter: Reporter = new PlainTextReporter({ output });

    reporter.report({
      kind: "failure",
      command: "build",
      phase: "build",
      code: "BUILD_FAILED",
      message: "Compilation failed.",
      cause: new Error("broken"),
    });
    await reporter.flush();

    expect(output.chunks.join("")).toBe("[BUILD_FAILED] Compilation failed. <- broken\n");
    expect(output.chunks.join("")).not.toContain("\u001B");
    expect(output.chunks.join("")).not.toContain("?");
  });

  test("renders the whole cause chain of a failure on one line", async () => {
    const output = new RecordingWritable();
    const reporter: Reporter = new PlainTextReporter({ output });

    reporter.report({
      kind: "failure",
      command: "dev",
      phase: "shutdown",
      code: "SHUTDOWN_FAILED",
      message: "Development child shutdown failed.",
      cause: new Error("Development child shutdown handshake failed.", {
        cause: new Error("Development child did not acknowledge shutdown."),
      }),
    });
    await reporter.flush();

    expect(output.chunks.join("")).toBe(
      "[SHUTDOWN_FAILED] Development child shutdown failed. <- Development child shutdown handshake failed. <- Development child did not acknowledge shutdown.\n",
    );
  });

  test("renders a repeated cause message only once", async () => {
    const output = new RecordingWritable();
    const reporter: Reporter = new PlainTextReporter({ output });
    const primary = new Error("injected lease release failure");

    reporter.report({
      kind: "failure",
      command: "dev",
      phase: "shutdown",
      code: "SHUTDOWN_FAILED",
      message: "dev command shutdown failed.",
      cause: new AggregateError([primary], "dev command shutdown failed.", { cause: primary }),
    });
    await reporter.flush();

    expect(output.chunks.join("")).toBe(
      "[SHUTDOWN_FAILED] dev command shutdown failed. <- injected lease release failure\n",
    );
  });

  test("keeps writing reports after a failed write", async () => {
    const output = new FirstWriteFailsWritable();
    const reporter: Reporter = new PlainTextReporter({ output });

    reporter.report({ kind: "success", command: "build", message: "lost to the failed write" });
    reporter.report({ kind: "success", command: "build", message: "after the failure" });
    // 拒绝本身是下一个用例的断言对象，这里只借 flush 等待队列排空。
    await reporter.flush().catch(() => {});

    expect(output.chunks.join("")).toBe("[build] after the failure\n");
  });

  test("flush surfaces the first write failure", async () => {
    const output = new FirstWriteFailsWritable();
    const reporter: Reporter = new PlainTextReporter({ output });

    reporter.report({ kind: "success", command: "build", message: "lost to the failed write" });
    reporter.report({ kind: "success", command: "build", message: "after the failure" });

    await expect(reporter.flush()).rejects.toBe(output.failure);
  });
});

async function collect(
  options: PlainTextReporterOptions,
  report: (reporter: Reporter) => void,
): Promise<string> {
  const output = new RecordingWritable();
  const reporter = new PlainTextReporter({ ...options, output });
  report(reporter);
  await reporter.flush();
  return normalizeTerminalOutput(output.chunks.join(""));
}

const diagnostic: ReportedDiagnostic = {
  code: "MISSING_BEAN",
  severity: "error",
  message: 'No Bean provides "PaymentGateway".',
  related: [],
};

describe("reporter render mode selection", () => {
  test("falls back to the greppable single line for a piped tool", async () => {
    const line = await collect({}, (reporter) =>
      reporter.report({ kind: "diagnostic", command: "build", phase: "compiler", diagnostic }),
    );

    expect(line).toBe('[MISSING_BEAN] No Bean provides "PaymentGateway".\n');
  });

  // 跨进程只能靠 env：父子各自构造 reporter，IPC 上没有 reporter 事件。
  test("honours the render mode handed down through the environment", async () => {
    const line = await collect({ env: { REFORCE_ERROR_FORMAT: "json" } }, (reporter) =>
      reporter.report({ kind: "diagnostic", command: "build", phase: "compiler", diagnostic }),
    );

    expect(JSON.parse(line)).toEqual({ kind: "diagnostic", ...diagnostic });
  });

  test("an explicit mode wins over the environment", async () => {
    const line = await collect(
      { mode: "short", env: { REFORCE_ERROR_FORMAT: "json" } },
      (reporter) =>
        reporter.report({ kind: "diagnostic", command: "build", phase: "compiler", diagnostic }),
    );

    expect(line).toBe('[MISSING_BEAN] No Bean provides "PaymentGateway".\n');
  });

  test("a piped application emits structured records for every event kind", async () => {
    const line = await collect({ audience: "application", env: {} }, (reporter) =>
      reporter.report({ kind: "success", command: "start", message: "Application started." }),
    );

    expect(JSON.parse(line)).toEqual({
      kind: "success",
      command: "start",
      message: "Application started.",
    });
  });
});

describe("failure rendering across modes", () => {
  // 竖排的理由：JS 的根因在链条最深处，横排时它被挤到行尾最容易被忽略。
  test("stacks the cause chain for humans with the root cause last", async () => {
    const output = await collect({ mode: "human" }, (reporter) =>
      reporter.report({
        kind: "failure",
        command: "dev",
        phase: "shutdown",
        code: "SHUTDOWN_FAILED",
        message: "Development child shutdown failed.",
        cause: new Error("Development child shutdown handshake failed.", {
          cause: new Error("Development child did not acknowledge shutdown."),
        }),
      }),
    );

    expect(output.split("\n").slice(0, 3)).toEqual([
      "error[SHUTDOWN_FAILED]: Development child shutdown failed.",
      "  caused by: Development child shutdown handshake failed.",
      "  caused by: Development child did not acknowledge shutdown.",
    ]);
  });

  // D5：运行期错误与编译期诊断同框——help 从 cause 链上取，抛出点常被包装若干层。
  test("surfaces a runtime error's help from inside the cause chain", async () => {
    const output = await collect({ mode: "human" }, (reporter) =>
      reporter.report(
        createFailureEvent({
          command: "start",
          phase: "bootstrap",
          fallbackCode: "BOOTSTRAP_FAILED",
          message: "Production bootstrap failed.",
          cause: new Error("wrapped", { cause: new UnregisteredBeanTargetError(class Absent {}) }),
        }),
      ),
    );

    expect(output).toContain("= help: Only classes the compiler saw as providers");
  });

  test("keeps the cause chain out of the JSON payload but not out of the record", async () => {
    const line = await collect({ mode: "json" }, (reporter) =>
      reporter.report({
        kind: "failure",
        command: "build",
        phase: "build",
        code: "BUILD_FAILED",
        message: "Compilation failed.",
        cause: new Error("broken"),
      }),
    );

    expect(JSON.parse(line)).toEqual({
      kind: "failure",
      command: "build",
      phase: "build",
      code: "BUILD_FAILED",
      message: "Compilation failed.",
      causes: ["broken"],
    });
  });
});

// D2（RFC 0011，#242）：dev 的 HMR 重载行原地重写，不滚屏。改一百次代码，终端上只占一行。
class InteractiveWritable extends RecordingWritable {
  readonly isTTY = true;
}

describe("transient status rendering", () => {
  async function collectInteractive(report: (reporter: Reporter) => void): Promise<string> {
    const output = new InteractiveWritable();
    const reporter = new PlainTextReporter({ mode: "human", output });
    report(reporter);
    await reporter.flush();
    return output.chunks.join("");
  }

  const reload = (message: string) =>
    ({
      kind: "status",
      command: "dev",
      phase: "hmr",
      message,
      transient: true,
    }) as const;

  const eraseLine = `${String.fromCodePoint(27)}[2K\r`;

  test("a second transient line erases the first instead of scrolling", async () => {
    const written = await collectInteractive((reporter) => {
      reporter.report(reload("first"));
      reporter.report(reload("second"));
    });

    // 两条之间恰好一个「擦掉本行并回到行首」，中间没有换行——换行就是滚屏。
    expect(written).toContain(eraseLine);
    expect(written.split("\n")).toHaveLength(2); // 内容行 + flush 收尾那个换行
  });

  // 悬着的原地行没有换行；不封上的话 shell 提示符会贴在它屁股后面，看起来像输出被截断。
  test("flush terminates a pending transient line", async () => {
    const written = await collectInteractive((reporter) => {
      reporter.report(reload("only"));
    });

    expect(written.endsWith("\n")).toBe(true);
  });

  // 不变量 3：三种模式同一份事件。管道里没有光标可回，转义序列会原样落进日志文件；
  // 按行读 stderr 的脚本一条都不能少。
  test("a piped run writes it as an ordinary line with no escape sequence", async () => {
    const written = await collect({ mode: "short" }, (reporter) => {
      reporter.report(reload("first"));
      reporter.report(reload("second"));
    });

    expect(written).not.toContain(eraseLine);
    expect(written.trimEnd().split("\n")).toHaveLength(2);
  });
});
