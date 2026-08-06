import type { CompilerDiagnostic } from "@reforce/compiler";
import type { Reporter } from "@reforce/runtime/reporter";
import { explainCommandFor } from "@/explain/codes";

// 四个上报点（build / dev / lib / dev 的 watch-coordinator）此前各写一遍同样的循环。「哪些码
// 有长文」是一条知识，散在四处就会漂移，所以在这里收成一处（RFC 0011 D8，#242）。
export function reportDiagnostics(input: {
  readonly reporter: Reporter;
  readonly command: "dev" | "build" | "lib";
  readonly phase: "project" | "compiler";
  readonly diagnostics: readonly CompilerDiagnostic[];
}): void {
  for (const diagnostic of input.diagnostics) {
    const explainCommand = explainCommandFor(diagnostic.code);
    input.reporter.report({
      kind: "diagnostic",
      command: input.command,
      phase: input.phase,
      diagnostic,
      ...(explainCommand === undefined ? {} : { explainCommand }),
    });
  }
}
