import { readFile } from "node:fs/promises";

export interface RawConfig {
  readonly extendValues: readonly string[];
  readonly files: unknown;
  readonly references: unknown;
}

interface JsonTextSlice {
  readonly text: string;
  readonly nextIndex: number;
}

function quotedJsonText(text: string, start: number): JsonTextSlice {
  const quote = text[start];
  let output = quote ?? "";
  let index = start + 1;
  while (index < text.length) {
    const current = text[index] ?? "";
    output += current;
    if (current === "\\") {
      output += text[index + 1] ?? "";
      index += 2;
      continue;
    }
    index += 1;
    if (current === quote) {
      break;
    }
  }
  return { text: output, nextIndex: index };
}

function afterLineComment(text: string, start: number): number {
  let index = start + 2;
  while (index < text.length && !["\r", "\n", "\u2028", "\u2029"].includes(text[index] ?? "")) {
    index += 1;
  }
  return index;
}

function afterBlockComment(text: string, start: number): number {
  let index = start + 2;
  while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
    index += 1;
  }
  return index + 2;
}

function stripJsonComments(text: string): string {
  let output = "";
  let index = 0;
  while (index < text.length) {
    const current = text[index] ?? "";
    const next = text[index + 1];
    if (current === '"' || current === "'") {
      const quoted = quotedJsonText(text, index);
      output += quoted.text;
      index = quoted.nextIndex;
      continue;
    }
    if (current === "/" && next === "/") {
      index = afterLineComment(text, index);
      continue;
    }
    if (current === "/" && next === "*") {
      index = afterBlockComment(text, index);
      continue;
    }
    output += current;
    index += 1;
  }
  // The trailing-comma rewrite runs over the whole text including string literals (a `,}` inside
  // a string is rewritten too); harmless for legal tsconfig, but must not be "fixed" casually.
  return output.replace(/,\s*([}\]])/gu, "$1");
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
  const parsed: unknown = JSON.parse(stripJsonComments(await readFile(configPath, "utf8")));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("tsconfig root must be an object");
  }
  return {
    extendValues: configExtendValues(Reflect.get(parsed, "extends")),
    files: Reflect.get(parsed, "files"),
    references: Reflect.get(parsed, "references"),
  };
}
