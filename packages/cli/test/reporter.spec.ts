import { describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import { PlainTextReporter, type Reporter } from "@/reporter";

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

    expect(output.chunks.join("")).toBe("[BUILD_FAILED] Compilation failed.\n");
    expect(output.chunks.join("")).not.toContain("\u001B");
    expect(output.chunks.join("")).not.toContain("?");
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
