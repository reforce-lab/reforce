import type { TsConfigJsonResolved } from "get-tsconfig";
import { normalizePatterns } from "@/project/config-file-discovery";
import { generatedDeclarationsPath } from "@/project/generated-paths";

function normalizedConfigPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "");
}

// Hand-rolled glob → RegExp for the single question "does this tsconfig pattern cover this
// path": `**/` matches zero or more directories, `*` and `?` stay within one path segment.
function globExpression(pattern: string): RegExp {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] ?? "";
    if (character === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index += 1;
      }
      continue;
    }
    if (character === "*") {
      expression += "[^/]*";
      continue;
    }
    if (character === "?") {
      expression += "[^/]";
      continue;
    }
    expression += /[\\^$.*+?()[\]{}|]/u.test(character) ? `\\${character}` : character;
  }
  return new RegExp(`${expression}$`, "u");
}

function patternCoversPath(pattern: string, target: string): boolean {
  const normalized = normalizedConfigPath(pattern);
  if (normalized === "." || normalized.length === 0) {
    return true;
  }
  if (!normalized.includes("*") && !normalized.includes("?")) {
    return target === normalized || target.startsWith(`${normalized}/`);
  }
  return globExpression(normalized).test(target);
}

export function generatedDeclarationsAreIncluded(config: TsConfigJsonResolved): boolean {
  const excludes = normalizePatterns(config.exclude);
  if (excludes.some((pattern) => patternCoversPath(pattern, generatedDeclarationsPath))) {
    return false;
  }
  const includes = normalizePatterns(config.include);
  const files = normalizePatterns(config.files);
  if (files.some((file) => normalizedConfigPath(file) === generatedDeclarationsPath)) {
    return true;
  }
  if (config.include !== undefined) {
    return includes.some((pattern) => patternCoversPath(pattern, generatedDeclarationsPath));
  }
  return config.files === undefined;
}
