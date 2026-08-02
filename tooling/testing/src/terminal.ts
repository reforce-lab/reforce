import stripAnsi from "strip-ansi";

export function normalizeTerminalOutput(output: string): string {
  return stripAnsi(output).replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}
