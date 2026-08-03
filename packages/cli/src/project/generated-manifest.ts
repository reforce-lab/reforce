// generated 树发布前的信任边界：directory-transaction 在发布（含崩溃恢复接管 staging 树）
// .reforce/generated 之前，用本文件的 validateGeneratedManifestBytes 校验 manifest.json 字节。
// 产物可能被手改、或来自与当前 CLI 错配的 compiler 版本，因此每条不变量都镜像契约生产方
// packages/compiler/src/emission/generate-files.ts 的 renderManifest 输出形状；schemaVersion、
// bean id 格式、lifecycle 归属、plans 三数组皆为线上协议，改动任一条都必须与生产方同步。
import { isObject } from "radashi";
import { hasExactKeys } from "@/project/exact-keys";

interface ManifestSourcePosition {
  readonly offset: number;
  readonly line: number;
  readonly character: number;
}

interface ManifestSourceReference {
  readonly file: string;
  readonly start: ManifestSourcePosition;
  readonly end: ManifestSourcePosition;
}

interface ManifestExportReference {
  readonly moduleSpecifier: string;
  readonly exportName: string;
}

interface ManifestSymbolReference extends ManifestExportReference {
  readonly displayName: string;
  readonly declaration?: ManifestSourceReference;
}

interface ManifestQualifier {
  readonly interface: ManifestSymbolReference;
  readonly member: string;
}

interface ManifestDependency {
  readonly parameterIndex: number;
  readonly targetId: string;
  readonly mode: "eager" | "cycle-proxy" | "explicit-lazy";
  readonly source: ManifestSourceReference;
}

interface ManifestLifecycle {
  readonly start: boolean;
  readonly close: boolean;
  readonly dispose: boolean;
}

interface ManifestBean {
  readonly id: string;
  readonly kind: "class" | "factory";
  readonly source: ManifestSourceReference;
  readonly runtimeExport: ManifestExportReference;
  readonly provides: readonly ManifestSymbolReference[];
  readonly dependencies: readonly ManifestDependency[];
  readonly primary: boolean;
  readonly qualifiers: readonly ManifestQualifier[];
  readonly lifecycle: ManifestLifecycle;
}

interface ManifestPlans {
  readonly constructionOrder: readonly string[];
  readonly startActionOrder: readonly string[];
  readonly cleanupActionOrder: readonly string[];
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isRelativePosixPath(value: string): boolean {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    /^[A-Za-z]:/u.test(value)
  ) {
    return false;
  }
  return value
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

// bean id 的线上格式为 `file#exportName`：恰好一个 "#"，且 file 必须是规范相对 posix 路径。
function beanIdParts(
  value: unknown,
): { readonly file: string; readonly exportName: string } | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const separator = value.indexOf("#");
  if (separator <= 0 || separator !== value.lastIndexOf("#") || separator === value.length - 1) {
    return undefined;
  }
  const file = value.slice(0, separator);
  if (!isRelativePosixPath(file)) {
    return undefined;
  }
  return { file, exportName: value.slice(separator + 1) };
}

function isSourcePosition(value: unknown): value is ManifestSourcePosition {
  return (
    isObject(value) &&
    hasExactKeys(value, ["offset", "line", "character"]) &&
    isNonnegativeInteger(Reflect.get(value, "offset")) &&
    isNonnegativeInteger(Reflect.get(value, "line")) &&
    isNonnegativeInteger(Reflect.get(value, "character"))
  );
}

function isSourceReference(value: unknown): value is ManifestSourceReference {
  if (!isObject(value) || !hasExactKeys(value, ["file", "start", "end"])) {
    return false;
  }
  const file = Reflect.get(value, "file");
  const start = Reflect.get(value, "start");
  const end = Reflect.get(value, "end");
  return (
    typeof file === "string" &&
    isRelativePosixPath(file) &&
    isSourcePosition(start) &&
    isSourcePosition(end) &&
    end.offset >= start.offset
  );
}

function isRuntimeModuleSpecifier(value: unknown): value is string {
  if (
    !isNonemptyString(value) ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value)
  ) {
    return false;
  }
  const relative = value.startsWith("./") || value.startsWith("../");
  if (!relative) {
    return !value.startsWith(".");
  }
  return (
    !value.split("/").includes("node_modules") &&
    (value.endsWith(".js") || value.endsWith(".mjs") || value.endsWith(".cjs"))
  );
}

function isRelativeRuntimeModuleSpecifier(value: string): boolean {
  return value.startsWith("./") || value.startsWith("../");
}

function isExportReference(value: unknown): value is ManifestExportReference {
  if (!isObject(value) || !hasExactKeys(value, ["moduleSpecifier", "exportName"])) {
    return false;
  }
  const moduleSpecifier = Reflect.get(value, "moduleSpecifier");
  return (
    isRuntimeModuleSpecifier(moduleSpecifier) &&
    isRelativeRuntimeModuleSpecifier(moduleSpecifier) &&
    isNonemptyString(Reflect.get(value, "exportName"))
  );
}

function isSymbolReference(value: unknown): value is ManifestSymbolReference {
  if (
    !isObject(value) ||
    !hasExactKeys(value, ["displayName", "moduleSpecifier", "exportName"], ["declaration"]) ||
    !isNonemptyString(Reflect.get(value, "displayName")) ||
    !isRuntimeModuleSpecifier(Reflect.get(value, "moduleSpecifier")) ||
    !isNonemptyString(Reflect.get(value, "exportName"))
  ) {
    return false;
  }
  const moduleSpecifier = Reflect.get(value, "moduleSpecifier");
  const declaration = Reflect.get(value, "declaration");
  return (
    (declaration === undefined || isSourceReference(declaration)) &&
    (isRelativeRuntimeModuleSpecifier(moduleSpecifier) || declaration === undefined)
  );
}

function symbolIdentity(value: ManifestSymbolReference): string {
  return `${value.moduleSpecifier}\0${value.exportName}`;
}

function isQualifier(value: unknown): value is ManifestQualifier {
  return (
    isObject(value) &&
    hasExactKeys(value, ["interface", "member"]) &&
    isSymbolReference(Reflect.get(value, "interface")) &&
    isNonemptyString(Reflect.get(value, "member"))
  );
}

function isLifecycle(value: unknown): value is ManifestLifecycle {
  return (
    isObject(value) &&
    hasExactKeys(value, ["start", "close", "dispose"]) &&
    typeof Reflect.get(value, "start") === "boolean" &&
    typeof Reflect.get(value, "close") === "boolean" &&
    typeof Reflect.get(value, "dispose") === "boolean"
  );
}

function isDependency(value: unknown, index: number): value is ManifestDependency {
  if (!isObject(value) || !hasExactKeys(value, ["parameterIndex", "targetId", "mode", "source"])) {
    return false;
  }
  const mode = Reflect.get(value, "mode");
  return (
    Reflect.get(value, "parameterIndex") === index &&
    beanIdParts(Reflect.get(value, "targetId")) !== undefined &&
    (mode === "eager" || mode === "cycle-proxy" || mode === "explicit-lazy") &&
    isSourceReference(Reflect.get(value, "source"))
  );
}

function hasUniqueSymbols(values: readonly ManifestSymbolReference[]): boolean {
  const identities = values.map(symbolIdentity);
  return new Set(identities).size === identities.length;
}

function hasValidQualifiers(
  qualifiers: readonly ManifestQualifier[],
  provides: readonly ManifestSymbolReference[],
): boolean {
  const provided = new Set(provides.map(symbolIdentity));
  const identities = qualifiers.map(
    (qualifier) => `${symbolIdentity(qualifier.interface)}\0${qualifier.member}`,
  );
  return (
    new Set(identities).size === identities.length &&
    qualifiers.every((qualifier) => provided.has(symbolIdentity(qualifier.interface)))
  );
}

function isManifestBean(value: unknown): value is ManifestBean {
  if (
    !isObject(value) ||
    !hasExactKeys(value, [
      "id",
      "kind",
      "source",
      "runtimeExport",
      "provides",
      "dependencies",
      "primary",
      "qualifiers",
      "lifecycle",
    ])
  ) {
    return false;
  }
  const id = Reflect.get(value, "id");
  const idParts = beanIdParts(id);
  const kind = Reflect.get(value, "kind");
  const source = Reflect.get(value, "source");
  const runtimeExport = Reflect.get(value, "runtimeExport");
  const provides = Reflect.get(value, "provides");
  const dependencies = Reflect.get(value, "dependencies");
  const qualifiers = Reflect.get(value, "qualifiers");
  const lifecycle = Reflect.get(value, "lifecycle");
  if (
    idParts === undefined ||
    (kind !== "class" && kind !== "factory") ||
    !isSourceReference(source) ||
    source.file !== idParts.file ||
    !isExportReference(runtimeExport) ||
    runtimeExport.exportName !== idParts.exportName ||
    !Array.isArray(provides) ||
    provides.length === 0 ||
    !provides.every(isSymbolReference) ||
    !hasUniqueSymbols(provides) ||
    !Array.isArray(dependencies) ||
    !dependencies.every(isDependency) ||
    typeof Reflect.get(value, "primary") !== "boolean" ||
    !Array.isArray(qualifiers) ||
    !qualifiers.every(isQualifier) ||
    !hasValidQualifiers(qualifiers, provides) ||
    !isLifecycle(lifecycle)
  ) {
    return false;
  }
  // factory bean 的 create 被 compiler 强制为零参数同步函数，故 dependencies 恒为空；
  // start/close 只属于 class 实例的生命周期方法，factory 仅有 dispose。
  if (kind === "factory") {
    return dependencies.length === 0 && !lifecycle.start && !lifecycle.close;
  }
  // class bean 必须把类自身列入 provides（实例按自身类型注册）；dispose 只属于 factory。
  return (
    !lifecycle.dispose &&
    provides.some(
      (provided) =>
        provided.moduleSpecifier === runtimeExport.moduleSpecifier &&
        provided.exportName === runtimeExport.exportName,
    )
  );
}

function isPlans(value: unknown): value is ManifestPlans {
  const keys = ["constructionOrder", "startActionOrder", "cleanupActionOrder"] as const;
  if (!isObject(value) || !hasExactKeys(value, keys)) {
    return false;
  }
  return keys.every((key) => {
    const entries = Reflect.get(value, key);
    return Array.isArray(entries) && entries.every((entry) => typeof entry === "string");
  });
}

function hasUniqueKnownIds(values: readonly string[], knownIds: ReadonlySet<string>): boolean {
  return values.every((id) => knownIds.has(id)) && new Set(values).size === values.length;
}

function exactlyCovers(values: readonly string[], expected: ReadonlySet<string>): boolean {
  return values.length === expected.size && values.every((id) => expected.has(id));
}

function hasValidPlans(plans: ManifestPlans, beans: readonly ManifestBean[]): boolean {
  const knownIds = new Set(beans.map((bean) => bean.id));
  if (
    !hasUniqueKnownIds(plans.constructionOrder, knownIds) ||
    !hasUniqueKnownIds(plans.startActionOrder, knownIds) ||
    !hasUniqueKnownIds(plans.cleanupActionOrder, knownIds) ||
    !exactlyCovers(plans.constructionOrder, knownIds)
  ) {
    return false;
  }
  const constructionIndexes = new Map(plans.constructionOrder.map((id, index) => [id, index]));
  for (const bean of beans) {
    const consumerIndex = constructionIndexes.get(bean.id);
    if (consumerIndex === undefined) {
      return false;
    }
    for (const dependency of bean.dependencies) {
      if (dependency.mode !== "eager") {
        continue;
      }
      const dependencyIndex = constructionIndexes.get(dependency.targetId);
      if (dependencyIndex === undefined || dependencyIndex >= consumerIndex) {
        return false;
      }
    }
  }
  const expectedStart = new Set(
    beans.flatMap((bean) => (bean.kind === "class" && bean.lifecycle.start ? [bean.id] : [])),
  );
  const expectedCleanup = new Set(
    beans.flatMap((bean) => {
      if (bean.kind === "class" && bean.lifecycle.close) {
        return [bean.id];
      }
      if (bean.kind === "factory" && bean.lifecycle.dispose) {
        return [bean.id];
      }
      return [];
    }),
  );
  return (
    exactlyCovers(plans.startActionOrder, expectedStart) &&
    exactlyCovers(plans.cleanupActionOrder, expectedCleanup)
  );
}

// 源路径的大小写不敏感冲突检测：macOS/Windows 默认文件系统上，仅大小写不同的两个文件会
// 互相覆盖，因此路径按 lowerCase 归一后必须唯一。compiler 编译期已拒绝此类冲突，此处对产物复检。
function registerSourcePath(
  source: ManifestSourceReference,
  portablePaths: Map<string, string>,
): boolean {
  const portable = source.file.toLowerCase();
  const existing = portablePaths.get(portable);
  if (existing !== undefined && existing !== source.file) {
    return false;
  }
  portablePaths.set(portable, source.file);
  return true;
}

function hasPortableSourcePaths(beans: readonly ManifestBean[]): boolean {
  const portablePaths = new Map<string, string>();
  for (const bean of beans) {
    const sources = [
      bean.source,
      ...bean.dependencies.map((dependency) => dependency.source),
      ...bean.provides.flatMap((provided) =>
        provided.declaration === undefined ? [] : [provided.declaration],
      ),
      ...bean.qualifiers.flatMap((qualifier) =>
        qualifier.interface.declaration === undefined ? [] : [qualifier.interface.declaration],
      ),
    ];
    if (sources.some((source) => !registerSourcePath(source, portablePaths))) {
      return false;
    }
  }
  return true;
}

function isGeneratedManifest(value: unknown): boolean {
  // schemaVersion 是硬版本门：无法识别的 schema 直接拒绝，不按错版契约解释产物字节。
  if (
    !isObject(value) ||
    !hasExactKeys(value, ["schemaVersion", "beans", "plans"]) ||
    Reflect.get(value, "schemaVersion") !== 1
  ) {
    return false;
  }
  const beans = Reflect.get(value, "beans");
  const plans = Reflect.get(value, "plans");
  if (!Array.isArray(beans) || !beans.every(isManifestBean) || !isPlans(plans)) {
    return false;
  }
  // bean id 与源路径同规则：除精确唯一外，按 lowerCase 归一后（portable id）也必须唯一，
  // 与 packages/context 的运行时校验互为双保险。
  const ids = beans.map((bean) => bean.id);
  const portableIds = ids.map((id) => id.toLowerCase());
  const knownIds = new Set(ids);
  if (
    knownIds.size !== ids.length ||
    new Set(portableIds).size !== portableIds.length ||
    !hasPortableSourcePaths(beans) ||
    beans.some((bean) => bean.dependencies.some((dependency) => !knownIds.has(dependency.targetId)))
  ) {
    return false;
  }
  return hasValidPlans(plans, beans);
}

export function validateGeneratedManifestBytes(bytes: Uint8Array): boolean {
  try {
    return isGeneratedManifest(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return false;
  }
}
