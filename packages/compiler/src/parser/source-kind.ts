import type { SourceKind } from "@/parser/source-ir";

export function sourceKindOf(file: string): SourceKind | undefined {
  if (file.endsWith(".d.mts")) {
    return "d.mts";
  }
  if (file.endsWith(".d.cts")) {
    return "d.cts";
  }
  if (file.endsWith(".d.ts")) {
    return "d.ts";
  }
  if (file.endsWith(".tsx")) {
    return "tsx";
  }
  if (file.endsWith(".mts")) {
    return "mts";
  }
  if (file.endsWith(".cts")) {
    return "cts";
  }
  return file.endsWith(".ts") ? "ts" : undefined;
}
