import { readFile } from "node:fs/promises";
import stripJsonComments from "strip-json-comments";

export interface RawConfig {
  readonly extendValues: readonly string[];
  readonly files: unknown;
  readonly references: unknown;
}

function configExtendValues(value: unknown): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value;
  }
  throw new Error("tsconfig extends must be a string or an array of strings");
}

export async function readRawConfig(configPath: string): Promise<RawConfig> {
  // strip-json-comments tracks string context, so `,]` and `//` inside a path stay literal. The
  // hand-written scanner it replaced removed trailing commas with a regex over the whole text and
  // silently rewrote those paths (Issue #58).
  const text = stripJsonComments(await readFile(configPath, "utf8"), { trailingCommas: true });
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("tsconfig root must be an object");
  }
  return {
    extendValues: configExtendValues(Reflect.get(parsed, "extends")),
    files: Reflect.get(parsed, "files"),
    references: Reflect.get(parsed, "references"),
  };
}
