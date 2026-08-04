import path from "node:path";
import { toPortablePath } from "@reforce/primitives";
import stableStringify from "json-stable-stringify";

// generate-files 与 generate-web-files 共享的渲染词汇：应用源 specifier 改写与稳定 JSON。
// 单列成模块是为了让两个生成器互不 import（避免环）。

// Ordered most- to least-specific: "x.d.mts" also ends with ".mts", so the declaration suffixes
// must be matched before their plain counterparts.
const runtimeExtensionMap = [
  [".d.mts", ".mjs"],
  [".d.cts", ".cjs"],
  [".d.ts", ".js"],
  [".mts", ".mjs"],
  [".cts", ".cjs"],
  [".tsx", ".js"],
  [".ts", ".js"],
] as const;

function runtimeSuffix(file: string): string {
  for (const [sourceExtension, runtimeExtension] of runtimeExtensionMap) {
    if (file.endsWith(sourceExtension)) {
      return `${file.slice(0, -sourceExtension.length)}${runtimeExtension}`;
    }
  }
  return file;
}

export function runtimeSpecifier(generatedDirectory: string, sourceFile: string): string {
  const relative = toPortablePath(path.relative(generatedDirectory, sourceFile));
  const withPrefix = relative.startsWith(".") ? relative : `./${relative}`;
  return runtimeSuffix(withPrefix);
}

export function json(value: unknown): string {
  const rendered = stableStringify(value, { space: 2 });
  if (rendered === undefined) {
    throw new Error("Generated data is not serializable");
  }
  return rendered;
}

function indent(value: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return value
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

export function inlineJson(value: unknown, spaces: number): string {
  return indent(json(value), spaces).trimStart();
}
