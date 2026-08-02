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
});
