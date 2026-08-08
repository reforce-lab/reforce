import { isRelativePosixPath } from "@reforce/primitives";
import { type MetaObjectShape, metaShapes } from "@/schema-shape";
import type { SourcePositionModel, SourceReferenceModel } from "@/source-reference";

// Starter meta schema v1（ADR 0004 决策 2/C2，#120）：本文件是 meta 字节的唯一准入。
// M1 以手写 JSON 钉死该 schema（#145），`reforce lib` 必须产出能通过这里校验的字节。
// 与 ADR 示意稿的两点收敛：source 携带完整 span（start/end/offset，与生成物的位置引用同形，
// 生成的 registration 需要它）；bean 仅支持类构造语义（dependencies 按构造参数位序）。
//
// ———— 兼容策略（#369）————
//
// 一个应用装**一个**编译器 + **N 个各自发布节奏**的 starter，所以这里的兼容规则必须按「读者
// 比写者旧」来设计：
//
// - **未知键一律忽略。** 不这么做的话，每加一个键都要升 major、全网 starter 同时失效。
//   严格模式（`strict`）只留给 `reforce lib` 的自产 round-trip 自检——那一侧读者与写者同版本，
//   出现未知键就是生成器与 schema 漂了。
// - **忽略即错的键登记进顶层 `requires`。** 忽略未知键对「缺席会改变语义」的键是灾难：
//   `collection` 缺席等于单边（见 parseDependency），旧编译器读新 meta 会把集合边静默注成单边。
//   登记之后，不认识该能力的读者当场硬错而不是错配。
//   **判据是「缺席会不会静默改变接线」**：`defaultBean` 缺席只会让 bean 以普通候选参与裁决、
//   撞车时报 AMBIGUOUS_BEAN（响亮），所以它不登记；`lifecycle` / `role` 从 v1 起就在 schema 里，
//   任何 v1 读者都认得，不构成前向风险。
// - **`schemaVersion` 只当 major 硬门**，单整数、无 minor。读者保留历史 major 的 parser，
//   一个编译器读 N 个 starter 版本。（首次公开发布前连同 #162 一次性归零。）

export const starterMetaSubpath = "./reforce-meta";

/** 本 parser 认得的 schema major。历史 major 的 parser 在这里并列，不做区间判断。 */
export const supportedSchemaVersions: readonly number[] = [1];

/**
 * `requires` 的合法词汇表：**缺席会静默改变接线**的键各占一个词。
 *
 * 加词的判据只有一条——「读者忽略这个键会不会导致错误的接线而不是响亮的报错」。答案是「会」
 * 才加。粒度语义发布后改不了，所以宁可窄。
 */
export const starterMetaCapabilities = ["collection"] as const;

export type StarterMetaCapability = (typeof starterMetaCapabilities)[number];

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
  /**
   * bean 声明处的位置，只喂诊断——没有任何消费者按字节解引用它。
   *
   * 对外可选（#369）：它是手写作者最易错、也最先过期的字段，而缺了它只是少一行位置，
   * 诊断照样说得清「这个 bean 由 starter X 的 meta 提供」。`reforce lib` 仍然照写。
   */
  readonly source?: SourceReferenceModel | undefined;
}

export interface StarterMeta {
  /** meta 点名要求读者认得的能力（见 starterMetaCapabilities）。 */
  readonly requires: readonly string[];
  readonly starterDeps: readonly string[];
  readonly symbols: readonly StarterMetaSymbol[];
  readonly beans: readonly StarterMetaBean[];
}

export type StarterMetaParseResult =
  | { readonly status: "success"; readonly meta: StarterMeta }
  | { readonly status: "unsupported-version"; readonly foundVersion: string }
  // 读者不认识 meta 点名要求的能力：硬错，而不是忽略后错配。
  | { readonly status: "unsupported-capability"; readonly required: readonly string[] }
  | { readonly status: "invalid"; readonly reason: string };

export interface ParseStarterMetaOptions {
  /**
   * 未知键改判非法。只给自产 round-trip 自检用（`reforce lib`）：那一侧读者与写者同版本，
   * 出现未知键说明生成器与 schema 漂了，正是要抓的。消费侧永远不开。
   */
  readonly strict?: boolean;
}

function invalid(reason: string): StarterMetaParseResult {
  return { status: "invalid", reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 必填键齐全即通过；未知键是否算错由 strict 决定（见文件头的兼容策略）。键名一律取自
// schema-shape 的单一清单，parser 与 JSON Schema 因此不可能各自漂。
function hasShape(
  value: Record<string, unknown>,
  shape: MetaObjectShape,
  strict: boolean,
): boolean {
  if (!shape.required.every((key) => key in value)) {
    return false;
  }
  if (!strict) {
    return true;
  }
  const known = new Set([...shape.required, ...shape.optional]);
  return Object.keys(value).every((key) => known.has(key));
}

function parsePosition(value: unknown, strict: boolean): SourcePositionModel | undefined {
  if (!isRecord(value) || !hasShape(value, metaShapes.position, strict)) {
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

function parseSourceReference(value: unknown, strict: boolean): SourceReferenceModel | undefined {
  if (!isRecord(value) || !hasShape(value, metaShapes.sourceReference, strict)) {
    return undefined;
  }
  const file = value.file;
  const start = parsePosition(value.start, strict);
  const end = parsePosition(value.end, strict);
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

function parseSymbol(
  value: unknown,
  packageName: string,
  strict: boolean,
): StarterMetaSymbol | string {
  if (!isRecord(value) || !hasShape(value, metaShapes.symbol, strict)) {
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
function parseDependency(
  value: unknown,
  beanId: string,
  strict: boolean,
): StarterMetaDependency | string {
  if (!isRecord(value) || !hasShape(value, metaShapes.dependency, strict)) {
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

function parseLifecycle(
  value: unknown,
  beanId: string,
  strict: boolean,
): StarterMetaBean["lifecycle"] | string {
  if (value === undefined) {
    return { start: false, close: false };
  }
  if (!isRecord(value) || !hasShape(value, metaShapes.lifecycle, strict)) {
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
  strict: boolean,
): StarterMetaBean["runtimeExport"] | string {
  if (!isRecord(value) || !hasShape(value, metaShapes.runtimeExport, strict)) {
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

function parseDependencies(
  value: unknown,
  id: string,
  strict: boolean,
): readonly StarterMetaDependency[] | string {
  if (!Array.isArray(value)) {
    return `bean ${id} dependencies must be an array`;
  }
  const dependencies: StarterMetaDependency[] = [];
  for (const dependency of value) {
    const parsed = parseDependency(dependency, id, strict);
    if (typeof parsed === "string") {
      return parsed;
    }
    dependencies.push(parsed);
  }
  return dependencies;
}

// defaultBean 与 role 都是「缺省即某个值」的可选标量，校验形状一致；合成一处是为了让 parseBean
// 停留在「逐段解析」这一个抽象层级上，而不是夹着两处标量类型判断。
function optionalMarkersProblem(value: Record<string, unknown>, id: string): string | undefined {
  if (value.defaultBean !== undefined && typeof value.defaultBean !== "boolean") {
    return `bean ${id} defaultBean must be a boolean`;
  }
  if (value.role !== undefined && value.role !== "demand" && value.role !== "root") {
    return `bean ${id} role only supports "demand" and "root"`;
  }
  return undefined;
}

function parseBean(value: unknown, packageName: string, strict: boolean): StarterMetaBean | string {
  if (!isRecord(value) || !hasShape(value, metaShapes.bean, strict)) {
    return "beans entries must have id, runtimeExport, provides, and dependencies";
  }
  const id = parseBeanId(value, packageName);
  if (id === "") {
    return `bean id ${String(value.id)} must be a <own package>#<export> coordinate`;
  }
  const runtimeExport = parseRuntimeExport(value.runtimeExport, id, packageName, strict);
  if (typeof runtimeExport === "string") {
    return runtimeExport;
  }
  const provides = parseProvides(value.provides, id);
  if (typeof provides === "string") {
    return provides;
  }
  const dependencies = parseDependencies(value.dependencies, id, strict);
  if (typeof dependencies === "string") {
    return dependencies;
  }
  const markersProblem = optionalMarkersProblem(value, id);
  if (markersProblem !== undefined) {
    return markersProblem;
  }
  const lifecycle = parseLifecycle(value.lifecycle, id, strict);
  if (typeof lifecycle === "string") {
    return lifecycle;
  }
  const source =
    value.source === undefined ? undefined : parseSourceReference(value.source, strict);
  if (value.source !== undefined && source === undefined) {
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
    ...(source === undefined ? {} : { source }),
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

function parseRequires(value: unknown): readonly string[] | string {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return "requires must list capability names";
  }
  return value.map(String);
}

export function parseStarterMeta(
  value: unknown,
  packageName: string,
  options: ParseStarterMetaOptions = {},
): StarterMetaParseResult {
  const strict = options.strict === true;
  if (!isRecord(value)) {
    return invalid("meta must be a JSON object");
  }
  if (
    typeof value.schemaVersion !== "number" ||
    !supportedSchemaVersions.includes(value.schemaVersion)
  ) {
    return { status: "unsupported-version", foundVersion: String(value.schemaVersion) };
  }
  if (!hasShape(value, metaShapes.root, strict)) {
    return invalid("meta must have schemaVersion, starterDeps, symbols, and beans");
  }
  const requires = parseRequires(value.requires);
  if (typeof requires === "string") {
    return invalid(requires);
  }
  // 能力门在其余校验之前：读者不认识的能力意味着接下来的解析结果本身不可信，继续往下读只会
  // 产出一份「看着成功、接线是错的」meta（#369）。
  const unsupported = requires.filter(
    (capability) => !(starterMetaCapabilities as readonly string[]).includes(capability),
  );
  if (unsupported.length > 0) {
    return { status: "unsupported-capability", required: unsupported };
  }
  const starterDeps = value.starterDeps;
  if (
    !Array.isArray(starterDeps) ||
    !starterDeps.every((item) => typeof item === "string" && isBarePackageName(item))
  ) {
    return invalid("starterDeps must list bare package names");
  }
  const symbols = parseUniqueEntries(value.symbols, "symbol", (entry) =>
    parseSymbol(entry, packageName, strict),
  );
  if (typeof symbols === "string") {
    return invalid(symbols);
  }
  const beans = parseUniqueEntries(value.beans, "bean", (entry) =>
    parseBean(entry, packageName, strict),
  );
  if (typeof beans === "string") {
    return invalid(beans);
  }
  return {
    status: "success",
    meta: { requires, starterDeps: starterDeps.map(String), symbols, beans },
  };
}
