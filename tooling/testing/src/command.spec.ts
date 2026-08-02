import { describe, expect, test } from "bun:test";
import { runCommand } from "#internal/command";
import { normalizeTerminalOutput } from "#internal/terminal";

describe("real commands", () => {
  test("passes arguments without shell interpolation", async () => {
    const result = await runCommand(process.execPath, [
      "-e",
      "process.stdout.write(process.argv[1])",
      "$(not-a-command)",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("$(not-a-command)");
  });

  test("returns a nonzero process result without replacing it with an exception", async () => {
    const result = await runCommand(process.execPath, ["-e", "process.exit(7)"]);

    expect(result.exitCode).toBe(7);
  });
});

describe("terminal output", () => {
  test("removes ANSI and normalizes platform line endings", () => {
    const output = normalizeTerminalOutput("\u001B[31merror\u001B[39m\r\nnext\rlast");

    expect(output).toBe("error\nnext\nlast");
  });
});
