import { readFile } from "node:fs/promises";
import path from "node:path";
import { compareUtf16CodeUnits } from "@reforce/primitives";

// 库模式的包面输入（ADR 0004 决策 2/7，#120/#147）：meta 户口表按 exports 的字面 subpath 枚举
// 类型入口。pattern subpath（含 "*"）与无类型目标的 subpath 不参与户口表——它们贡献不了可锚定的
// 契约符号；`./reforce-meta` 是本机制自己的契约面，不进公开符号枚举。

const reservedSubpaths = new Set(["./reforce-meta", "./package.json"]);

// 与应用侧 module-resolver 的 conditionNames（types 优先，再 import/default）同口径。
const typeConditionNames = ["types", "import", "default"];

const typeTargetPattern = /\.(?:d\.ts|d\.mts|d\.cts|ts|mts|cts|tsx)$/u;

export interface LibrarySubpathEntry {
  readonly subpath: string;
  readonly typesFile: string;
}

export interface LibraryPackageManifest {
  readonly packageJsonPath: string;
  readonly name: string;
  readonly subpaths: readonly LibrarySubpathEntry[];
}

export type LibraryPackageResult =
  | { readonly status: "success"; readonly manifest: LibraryPackageManifest }
  | { readonly status: "failure"; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstTypeTarget(candidates: readonly unknown[]): string | undefined {
  for (const candidate of candidates) {
    const target = typeTargetOf(candidate);
    if (target !== undefined) {
      return target;
    }
  }
  return undefined;
}

function typeTargetOf(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.startsWith("./") && typeTargetPattern.test(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    return firstTypeTarget(value);
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const conditionTargets = Object.keys(value)
    .filter((key) => typeConditionNames.includes(key))
    .map((key) => value[key]);
  return firstTypeTarget(conditionTargets);
}

// exports 的两种形态（Node packages 语义）：任一键以 "." 开头即 subpath 表，否则整个对象
// （或字符串）是 "." 的目标缩写。
function normalizeExports(exports: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof exports === "string") {
    return { ".": exports };
  }
  if (!isRecord(exports)) {
    return undefined;
  }
  const keys = Object.keys(exports);
  if (keys.some((key) => key === "." || key.startsWith("./"))) {
    return exports;
  }
  return { ".": exports };
}

function collectSubpaths(
  exports: Readonly<Record<string, unknown>>,
  projectRoot: string,
): readonly LibrarySubpathEntry[] {
  const entries: LibrarySubpathEntry[] = [];
  for (const [subpath, target] of Object.entries(exports)) {
    if (
      (subpath !== "." && !subpath.startsWith("./")) ||
      reservedSubpaths.has(subpath) ||
      subpath.includes("*")
    ) {
      continue;
    }
    const typesTarget = typeTargetOf(target);
    if (typesTarget === undefined) {
      continue;
    }
    entries.push({ subpath, typesFile: path.join(projectRoot, typesTarget) });
  }
  return entries.toSorted((left, right) => compareUtf16CodeUnits(left.subpath, right.subpath));
}

export async function readLibraryPackage(projectRoot: string): Promise<LibraryPackageResult> {
  const packageJsonPath = path.join(projectRoot, "package.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(packageJsonPath, "utf8"));
  } catch {
    return { status: "failure", reason: `Cannot read ${packageJsonPath} as JSON.` };
  }
  if (!isRecord(parsed)) {
    return { status: "failure", reason: "package.json must be a JSON object." };
  }
  const name = parsed.name;
  if (typeof name !== "string" || name.length === 0) {
    return { status: "failure", reason: "package.json must declare a package name." };
  }
  const exports = normalizeExports(parsed.exports);
  if (exports === undefined) {
    return {
      status: "failure",
      reason: "package.json must declare an exports map; meta symbol subpaths come from it.",
    };
  }
  const subpaths = collectSubpaths(exports, projectRoot);
  if (subpaths.length === 0) {
    return {
      status: "failure",
      reason:
        "package.json exports expose no literal subpath with a TypeScript declaration target.",
    };
  }
  return {
    status: "success",
    manifest: { packageJsonPath, name, subpaths },
  };
}
