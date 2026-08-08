import { isRelativePosixPath } from "@reforce/primitives";
import type { GeneratedSourceReferenceModel } from "@/analysis/model";

// Starter meta schema v1（ADR 0004 决策 2/C2，#120）：本文件是应用侧对 meta 字节的唯一准入。
// M1 以手写 JSON 钉死该 schema（#145），M2 的 `reforce lib` 必须产出能通过这里校验的字节。
// 与 ADR 示意稿的两点收敛：source 携带完整 span（start/end/offset，与 GeneratedSourceReference
// 同形，生成的 registration 需要它）；bean 仅支持类构造语义（dependencies 按构造参数位序）。

export const starterMetaSubpath = "./reforce-meta";

// 符号坐标两种形态（决策 7）：`包名#导出名` 走 meta 户口表归一；`包名:包内相对路径#导出名`
// 是无 meta 契约包的文件身份退化形，两侧解析的是同一份安装文件，天然一致。
export type StarterContractCoordinate =
  | { readonly kind: "meta"; readonly packageName: string; readonly exportName: string }
  | {
      readonly kind: "file";
      readonly packageName: string;
      readonly file: string;
      readonly exportName: string;
    };

function isBarePackageName(value: string): boolean {
  if (
    value.length === 0 ||
    value.startsWith(".") ||
    value.startsWith("/") ||
    value.includes("\\")
  ) {
    return false;
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0)) {
    return false;
  }
  if (value.startsWith("@")) {
    return segments.length === 2;
  }
  return segments.length === 1;
}

export function parseContractCoordinate(value: string): StarterContractCoordinate | undefined {
  const separator = value.indexOf("#");
  if (separator <= 0 || separator !== value.lastIndexOf("#") || separator === value.length - 1) {
    return undefined;
  }
  const location = value.slice(0, separator);
  const exportName = value.slice(separator + 1);
  const colon = location.indexOf(":");
  if (colon === -1) {
    return isBarePackageName(location)
      ? { kind: "meta", packageName: location, exportName }
      : undefined;
  }
  const packageName = location.slice(0, colon);
  const file = location.slice(colon + 1);
  return isBarePackageName(packageName) && isRelativePosixPath(file)
    ? { kind: "file", packageName, file, exportName }
    : undefined;
}

export interface StarterMetaSymbol {
  readonly id: string;
  readonly exportName: string;
  readonly file: string;
  readonly subpaths: readonly string[];
}

export interface StarterMetaDependency {
  readonly contract: string;
  readonly open: boolean;
  // 构造参数是 readonly T[]：该契约的全部候选按集合语义注入（零成员合法）。
  readonly collection: boolean;
}

export interface StarterMetaBean {
  readonly id: string;
  readonly runtimeExport: { readonly module: string; readonly export: string };
  readonly provides: readonly string[];
  readonly dependencies: readonly StarterMetaDependency[];
  readonly defaultBean: boolean;
  readonly role: "demand" | "root";
  readonly lifecycle: { readonly start: boolean; readonly close: boolean };
  readonly source: GeneratedSourceReferenceModel;
}

export interface StarterMeta {
  readonly starterDeps: readonly string[];
  readonly symbols: readonly StarterMetaSymbol[];
  readonly beans: readonly StarterMetaBean[];
}

export type StarterMetaParseResult =
  | { readonly status: "success"; readonly meta: StarterMeta }
  | { readonly status: "unsupported-version"; readonly foundVersion: string }
  | { readonly status: "invalid"; readonly reason: string };

function invalid(reason: string): StarterMetaParseResult {
  return { status: "invalid", reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const known = new Set([...required, ...optional]);
  return required.every((key) => key in value) && Object.keys(value).every((key) => known.has(key));
}

function parsePosition(value: unknown): GeneratedSourceReferenceModel["start"] | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["offset", "line", "character"])) {
    return undefined;
  }
  const { offset, line, character } = value;
  const valid = [offset, line, character].every(
    (item) => typeof item === "number" && Number.isInteger(item) && item >= 0,
  );
  return valid &&
    typeof offset === "number" &&
    typeof line === "number" &&
    typeof character === "number"
    ? { offset, line, character }
    : undefined;
}

function parseSourceReference(value: unknown): GeneratedSourceReferenceModel | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["file", "start", "end"])) {
    return undefined;
  }
  const file = value.file;
  const start = parsePosition(value.start);
  const end = parsePosition(value.end);
  if (
    typeof file !== "string" ||
    !isRelativePosixPath(file) ||
    start === undefined ||
    end === undefined
  ) {
    return undefined;
  }
  return end.offset >= start.offset ? { file, start, end } : undefined;
}

function parseSymbol(value: unknown, packageName: string): StarterMetaSymbol | string {
  if (!isRecord(value) || !hasOnlyKeys(value, ["id", "file", "subpaths"])) {
    return "symbols entries must have exactly id, file, and subpaths";
  }
  const { id, file, subpaths } = value;
  if (typeof id !== "string") {
    return "symbol id must be a string";
  }
  const coordinate = parseContractCoordinate(id);
  if (coordinate?.kind !== "meta" || coordinate.packageName !== packageName) {
    return `symbol id ${id} must be a <own package>#<export> coordinate`;
  }
  if (typeof file !== "string" || !isRelativePosixPath(file)) {
    return `symbol ${id} file must be a package-relative posix path`;
  }
  if (
    !Array.isArray(subpaths) ||
    subpaths.length === 0 ||
    !subpaths.every(
      (subpath) => subpath === "." || (typeof subpath === "string" && subpath.startsWith("./")),
    )
  ) {
    return `symbol ${id} subpaths must list "." or "./..." entries`;
  }
  return { id, exportName: coordinate.exportName, file, subpaths: subpaths.map(String) };
}

// collection 是可选键（#228）：省略即单边，老 meta 一字不改仍然合法。反过来不成立——schemaVersion
// 是 `!== 1` 硬拒（parseStarterMeta），没有 minor 概念，带 collection 键的新 meta 被旧编译器
// 读到会在这里落 INVALID_STARTER_META。仓内单版本可接受，对外发版前要连同 #162 的
// schemaVersion 归零一起处理。
function parseDependency(value: unknown, beanId: string): StarterMetaDependency | string {
  if (!isRecord(value) || !hasOnlyKeys(value, ["contract", "open"], ["collection"])) {
    return `bean ${beanId} dependencies entries must have exactly contract and open`;
  }
  const { contract, open, collection } = value;
  if (typeof contract !== "string" || parseContractCoordinate(contract) === undefined) {
    return `bean ${beanId} dependency contract must be a symbol coordinate`;
  }
  if (typeof open !== "boolean") {
    return `bean ${beanId} dependency open must be a boolean`;
  }
  if (collection !== undefined && typeof collection !== "boolean") {
    return `bean ${beanId} dependency collection must be a boolean`;
  }
  return { contract, open, collection: collection === true };
}

function parseLifecycle(value: unknown, beanId: string): StarterMetaBean["lifecycle"] | string {
  if (value === undefined) {
    return { start: false, close: false };
  }
  if (!isRecord(value) || !hasOnlyKeys(value, [], ["start", "close"])) {
    return `bean ${beanId} lifecycle only supports start and close`;
  }
  if (value.start !== undefined && value.start !== "onContextStart") {
    return `bean ${beanId} lifecycle.start only supports "onContextStart"`;
  }
  if (value.close !== undefined && value.close !== "onContextClose") {
    return `bean ${beanId} lifecycle.close only supports "onContextClose"`;
  }
  return { start: value.start === "onContextStart", close: value.close === "onContextClose" };
}

function parseRuntimeExport(
  value: unknown,
  beanId: string,
  packageName: string,
): StarterMetaBean["runtimeExport"] | string {
  if (!isRecord(value) || !hasOnlyKeys(value, ["module", "export"])) {
    return `bean ${beanId} runtimeExport must have exactly module and export`;
  }
  const { module, export: exportName } = value;
  if (
    typeof module !== "string" ||
    (module !== packageName && !module.startsWith(`${packageName}/`))
  ) {
    return `bean ${beanId} runtimeExport.module must stay inside ${packageName}`;
  }
  if (typeof exportName !== "string" || exportName.length === 0) {
    return `bean ${beanId} runtimeExport.export must be a nonempty string`;
  }
  return { module, export: exportName };
}

function parseBeanId(value: Record<string, unknown>, packageName: string): string {
  const id = value.id;
  if (typeof id !== "string") {
    return "";
  }
  const coordinate = parseContractCoordinate(id);
  return coordinate?.kind === "meta" && coordinate.packageName === packageName ? id : "";
}

function parseProvides(value: unknown, id: string): readonly string[] | string {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item) => typeof item === "string" && parseContractCoordinate(item) !== undefined)
  ) {
    return `bean ${id} provides must be a nonempty list of symbol coordinates`;
  }
  if (!value.includes(id)) {
    return `bean ${id} provides must include the bean's own coordinate`;
  }
  return value.map(String);
}

function parseDependencies(value: unknown, id: string): readonly StarterMetaDependency[] | string {
  if (!Array.isArray(value)) {
    return `bean ${id} dependencies must be an array`;
  }
  const dependencies: StarterMetaDependency[] = [];
  for (const dependency of value) {
    const parsed = parseDependency(dependency, id);
    if (typeof parsed === "string") {
      return parsed;
    }
    dependencies.push(parsed);
  }
  return dependencies;
}

function parseBean(value: unknown, packageName: string): StarterMetaBean | string {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      ["id", "runtimeExport", "provides", "dependencies", "source"],
      ["defaultBean", "role", "lifecycle"],
    )
  ) {
    return "beans entries must have id, runtimeExport, provides, dependencies, and source";
  }
  const id = parseBeanId(value, packageName);
  if (id === "") {
    return `bean id ${String(value.id)} must be a <own package>#<export> coordinate`;
  }
  const runtimeExport = parseRuntimeExport(value.runtimeExport, id, packageName);
  if (typeof runtimeExport === "string") {
    return runtimeExport;
  }
  const provides = parseProvides(value.provides, id);
  if (typeof provides === "string") {
    return provides;
  }
  const dependencies = parseDependencies(value.dependencies, id);
  if (typeof dependencies === "string") {
    return dependencies;
  }
  if (value.defaultBean !== undefined && typeof value.defaultBean !== "boolean") {
    return `bean ${id} defaultBean must be a boolean`;
  }
  if (value.role !== undefined && value.role !== "demand" && value.role !== "root") {
    return `bean ${id} role only supports "demand" and "root"`;
  }
  const lifecycle = parseLifecycle(value.lifecycle, id);
  if (typeof lifecycle === "string") {
    return lifecycle;
  }
  const source = parseSourceReference(value.source);
  if (source === undefined) {
    return `bean ${id} source must be a package-relative span with start and end positions`;
  }
  return {
    id,
    runtimeExport,
    provides,
    dependencies,
    defaultBean: value.defaultBean === true,
    role: value.role === "root" ? "root" : "demand",
    lifecycle,
    source,
  };
}

function parseUniqueEntries<T extends { readonly id: string }>(
  value: unknown,
  label: string,
  parseEntry: (entry: unknown) => T | string,
): readonly T[] | string {
  if (!Array.isArray(value)) {
    return `${label}s must be an array`;
  }
  const entries: T[] = [];
  const ids = new Set<string>();
  for (const entry of value) {
    const parsed = parseEntry(entry);
    if (typeof parsed === "string") {
      return parsed;
    }
    if (ids.has(parsed.id)) {
      return `duplicate ${label} id ${parsed.id}`;
    }
    ids.add(parsed.id);
    entries.push(parsed);
  }
  return entries;
}

export function parseStarterMeta(value: unknown, packageName: string): StarterMetaParseResult {
  if (!isRecord(value)) {
    return invalid("meta must be a JSON object");
  }
  if (value.schemaVersion !== 1) {
    return { status: "unsupported-version", foundVersion: String(value.schemaVersion) };
  }
  if (!hasOnlyKeys(value, ["schemaVersion", "starterDeps", "symbols", "beans"])) {
    return invalid("meta must have exactly schemaVersion, starterDeps, symbols, and beans");
  }
  const starterDeps = value.starterDeps;
  if (
    !Array.isArray(starterDeps) ||
    !starterDeps.every((item) => typeof item === "string" && isBarePackageName(item))
  ) {
    return invalid("starterDeps must list bare package names");
  }
  const symbols = parseUniqueEntries(value.symbols, "symbol", (entry) =>
    parseSymbol(entry, packageName),
  );
  if (typeof symbols === "string") {
    return invalid(symbols);
  }
  const beans = parseUniqueEntries(value.beans, "bean", (entry) => parseBean(entry, packageName));
  if (typeof beans === "string") {
    return invalid(beans);
  }
  return {
    status: "success",
    meta: { starterDeps: starterDeps.map(String), symbols, beans },
  };
}
