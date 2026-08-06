// generated 树发布前的信任边界：directory-transaction 在发布（含崩溃恢复接管 staging 树）
// .reforce/generated 之前，用本文件的 validateGeneratedManifestBytes 校验 manifest.json 字节。
// 产物可能被手改、或来自与当前 CLI 错配的 compiler 版本，因此每条不变量都镜像契约生产方
// packages/compiler/src/emission/generate-files.ts 的 renderManifest 输出形状；schemaVersion、
// bean id 格式、lifecycle 归属、plans 三数组皆为线上协议，改动任一条都必须与生产方同步。
import { isRelativePosixPath } from "@reforce/primitives";
import { isObject, isString } from "radashi";
import { hasExactKeys } from "@/project/exact-keys";

interface ManifestSourcePosition {
  readonly offset: number;
  readonly line: number;
  readonly character: number;
}

// 类型面（Manifest*、GeneratedManifest）随 parseGeneratedManifestBytes 导出：explain 命令
// （Issue #148）以同一信任边界消费 manifest，字段形状只在此处声明一次。
export interface ManifestSourceReference {
  readonly file: string;
  readonly start: ManifestSourcePosition;
  readonly end: ManifestSourcePosition;
}

export interface ManifestExportReference {
  readonly moduleSpecifier: string;
  readonly exportName: string;
}

export interface ManifestSymbolReference extends ManifestExportReference {
  readonly displayName: string;
  readonly declaration?: ManifestSourceReference;
}

interface ManifestQualifier {
  readonly interface: ManifestSymbolReference;
  readonly member: string;
}

export interface ManifestSingleDependency {
  readonly parameterIndex: number;
  readonly targetId: string;
  // "current"（ADR 0006 W7，#151 / schema v4）：singleton 持有请求态句柄的唯一通道。
  readonly mode: "eager" | "cycle-proxy" | "explicit-lazy" | "current";
  readonly source: ManifestSourceReference;
}

export interface ManifestCollectionMember {
  readonly targetId: string;
  readonly mode: "eager" | "cycle-proxy";
}

// 集合边（ADR 0006 W6，#150 / schema v3）：members 顺序即注入顺序，编译期已按 @Order 与
// beanId 决胜写死。
export interface ManifestCollectionDependency {
  readonly parameterIndex: number;
  readonly mode: "collection";
  readonly members: readonly ManifestCollectionMember[];
  readonly source: ManifestSourceReference;
}

export type ManifestDependency = ManifestSingleDependency | ManifestCollectionDependency;

// 计划位置与目标存在性检查只关心"边指向谁、什么模式"；集合边按成员展开成同构目标边。
export function manifestDependencyEdges(
  dependency: ManifestDependency,
): readonly { readonly targetId: string; readonly mode: string }[] {
  return dependency.mode === "collection" ? dependency.members : [dependency];
}

interface ManifestLifecycle {
  readonly start: boolean;
  readonly close: boolean;
  readonly dispose: boolean;
}

export interface ManifestBean {
  readonly id: string;
  readonly origin: string;
  readonly kind: "class" | "factory";
  // scope 是编译期属性（ADR 0006 W7，#151 / schema v4）：请求 bean 走第二组构造计划。
  readonly scope: "singleton" | "request";
  readonly source: ManifestSourceReference;
  readonly runtimeExport: ManifestExportReference;
  readonly provides: readonly ManifestSymbolReference[];
  readonly dependencies: readonly ManifestDependency[];
  readonly primary: boolean;
  // @Order(n) 的整数值（ADR 0006 W6）；仅带标记的 bean 写该键。
  readonly order?: number;
  readonly qualifiers: readonly ManifestQualifier[];
  readonly lifecycle: ManifestLifecycle;
}

// config 条目（ADR 0005，#130）：恒为应用侧声明，不进 plans——实例由运行时绑定 phase 先于
// 一切 bean 构造，bean 依赖可以指向 config id。
export interface ManifestConfig {
  readonly id: string;
  readonly prefix: string;
  readonly source: ManifestSourceReference;
  readonly provides: readonly ManifestSymbolReference[];
}

interface ManifestPlans {
  readonly constructionOrder: readonly string[];
  readonly requestConstructionOrder: readonly string[];
  readonly startActionOrder: readonly string[];
  readonly cleanupActionOrder: readonly string[];
}

export interface GeneratedManifest {
  readonly schemaVersion: 5;
  readonly configs: readonly ManifestConfig[];
  readonly beans: readonly ManifestBean[];
  readonly plans: ManifestPlans;
}

// 与 compiler（analysis/config-provider.ts）及 @reforce/config 运行时同一条 prefix 规则；
// 产物字节可能被手改，此处按线上协议复检。
const configPrefixPattern = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$/;

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

// `Array.isArray(value)` 在 value: unknown 上只窄化到 any[]，而 `every` 带类型谓词也不改变数组
// 自身的类型，于是后续的元素字段访问全部退化成无检查的 any（Issue #91）。本文件读的是可能被手改
// 的产物字节，元素形状恰恰是要校验的对象，因此数组字段一律经此守卫收敛到具体元素类型再访问。
function isArrayOf<T>(
  value: unknown,
  isItem: (item: unknown, index: number) => item is T,
): value is readonly T[] {
  if (!Array.isArray(value)) {
    return false;
  }
  const items: readonly unknown[] = value;
  return items.every(isItem);
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

// 同一条 bean 记录里 `source.file` 与 `moduleSpecifier` 松紧不同不是疏漏，是基准不同（Issue #104）：
// source.file 相对项目根，`..` 恒不合法；moduleSpecifier 相对 <root>/.reforce/generated
// （compiler/src/project/generated-paths.ts），指回源码必须且只需退两级。退级数因此是定值，退完剩下的
// 部分与 source.file 同为项目根相对路径，走同一条 isRelativePosixPath。
const GENERATED_TO_PROJECT_ROOT = "../../";

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
  if (!isRelativeRuntimeModuleSpecifier(value)) {
    // 裸 specifier（包名）：只有 provides 里的外部 symbol 走这条分支，"." 开头必然是退级数不对的相对路径。
    return !value.startsWith(".");
  }
  const projectRelative = value.slice(GENERATED_TO_PROJECT_ROOT.length);
  return (
    isRelativePosixPath(projectRelative) &&
    !projectRelative.split("/").includes("node_modules") &&
    (value.endsWith(".js") || value.endsWith(".mjs") || value.endsWith(".cjs"))
  );
}

function isRelativeRuntimeModuleSpecifier(value: string): boolean {
  return value.startsWith(GENERATED_TO_PROJECT_ROOT);
}

function isExportReference(value: unknown): value is ManifestExportReference {
  if (!isObject(value) || !hasExactKeys(value, ["moduleSpecifier", "exportName"])) {
    return false;
  }
  return (
    isRuntimeModuleSpecifier(Reflect.get(value, "moduleSpecifier")) &&
    isNonemptyString(Reflect.get(value, "exportName"))
  );
}

// origin 线上格式（ADR 0004 决策 16，#120）：应用 bean 恒为 "application"，starter bean 为
// `包名@版本`。scoped 包名自带前导 "@"，版本分隔取最后一个 "@" 且不得在首位或末位。
// export 给 explain 命令拆 origin：包名/版本的切分规则必须与这里的校验同源。
export function starterOriginPackageName(origin: string): string | undefined {
  const separator = origin.lastIndexOf("@");
  if (separator <= 0 || separator === origin.length - 1) {
    return undefined;
  }
  const packageName = origin.slice(0, separator);
  return isRelativePosixPath(packageName) ? packageName : undefined;
}

// 框架合成 bean 的来源串（ADR 0008 AM2，#204 定案 6）：与 starter 的 "包名@版本" 相区分——
// 无版本段，starterOriginPackageName 对它返回 undefined，starter meta 发现与多拷贝呈现自动
// 跳过。生产方是 compiler/src/analysis/transaction-weaving.ts。
//
// 一张表而不是一个字面量：合成 bean 归哪个框架包由它实现的契约决定（事务契约随 #204 的拆包
// 迁到 @reforce/transaction），CLI 这道信任边界要比对的是"这个来源允许合成哪个 bean、从哪个
// 生成入口 import"这一整组事实，认死一个包名会在下一个框架包出现时静默放行。
interface FrameworkBeanSpec {
  /** 运行导出名。多数框架 bean 的 id exportName 与它相等，logger 是唯一的例外。 */
  readonly exportName: string;
  readonly runtimeModule: string;
  /** id 的 exportName 不等于运行导出名时，用它校验 id 的形状。 */
  readonly exportNamePattern?: RegExp;
  /** 不提供任何契约的合成 bean（logger）；其余框架 bean 必须把自己列进 provides。 */
  readonly providesNothing?: true;
}

// 一个来源可以合成不止一种 bean：@reforce/logging 出两种（逐 logger 的 BoundLogger，与全图
// 唯一的级别快照），形状互不相同，所以值是一组 spec 而不是一条——认死一条会在第二种出现时
// 把合法产物判成非法。
const frameworkBeanSpecs = new Map<string, readonly FrameworkBeanSpec[]>([
  [
    "@reforce/transaction",
    [
      {
        exportName: "TransactionInterceptor",
        runtimeModule: "@reforce/transaction/generated-runtime",
      },
    ],
  ],
  [
    "@reforce/logging",
    [
      // 框架 logger（RFC 0011 L2，#242）：唯一「一个运行导出承载 N 个 bean 身份」的形态。
      // id 的 exportName 是 `Logger(<名字>)` 这个模式而不是一个定名，运行导出恒为 BoundLogger
      // ——两者天然不等，而其余框架 bean 靠「相等」把关。它也刻意不提供任何契约（消费者由编译器
      // 的重定向表点名），所以 provides 恒为空。
      {
        exportNamePattern: /^Logger\(.+\)$/u,
        exportName: "BoundLogger",
        runtimeModule: "@reforce/logging/generated-runtime",
        providesNothing: true,
      },
      // 级别快照（RFC 0011 L5，#249）：全图唯一一条，构造实参是编译期算好的字面量快照。
      // 与 logger bean 同理不进候选池——注入它的绑定由 isLoggerLevelsContract 点名。
      {
        exportName: "LoggerLevels",
        runtimeModule: "@reforce/logging/generated-runtime",
        providesNothing: true,
      },
    ],
  ],
]);

export const loggingOriginId = "@reforce/logging";

export function isFrameworkOrigin(origin: string): boolean {
  return frameworkBeanSpecs.has(origin);
}

// 框架 bean 的专属不变量：id 恒为 `<框架包>#<合成导出名>`，runtimeExport 指向该包的生成入口，
// declarationSource 指向把它拉进图的第一处使用处（应用侧路径），无生命周期、无 qualifier、
// 非 primary。
function isFrameworkBean(
  bean: {
    readonly idParts: { readonly file: string; readonly exportName: string };
    readonly kind: "class" | "factory";
    readonly runtimeExport: ManifestExportReference;
    readonly provides: readonly ManifestSymbolReference[];
    readonly lifecycle: ManifestLifecycle;
  },
  origin: string,
  primary: boolean,
  qualifiers: readonly ManifestQualifier[],
): boolean {
  const specs = frameworkBeanSpecs.get(origin);
  if (specs === undefined) {
    return false;
  }
  // 与来源共通的那部分先判一次：它们对该来源的每一种合成 bean 都成立，逐 spec 重复判等于
  // 把「框架 bean 一律无生命周期、无 qualifier」这条不变量藏进循环里。
  const commonHolds =
    bean.idParts.file === origin &&
    bean.kind === "class" &&
    !primary &&
    qualifiers.length === 0 &&
    !bean.lifecycle.start &&
    !bean.lifecycle.close &&
    !bean.lifecycle.dispose;
  return commonHolds && specs.some((spec) => matchesFrameworkSpec(bean, spec));
}

function matchesFrameworkSpec(
  bean: {
    readonly idParts: { readonly exportName: string };
    readonly runtimeExport: ManifestExportReference;
    readonly provides: readonly ManifestSymbolReference[];
  },
  spec: FrameworkBeanSpec,
): boolean {
  const identityHolds =
    spec.exportNamePattern === undefined
      ? bean.idParts.exportName === spec.exportName
      : spec.exportNamePattern.test(bean.idParts.exportName) &&
        bean.runtimeExport.exportName === spec.exportName;
  const providesHold = spec.providesNothing
    ? bean.provides.length === 0
    : bean.provides.some(
        (provided) =>
          provided.exportName === bean.runtimeExport.exportName &&
          provided.moduleSpecifier === spec.runtimeModule,
      );
  return identityHolds && bean.runtimeExport.moduleSpecifier === spec.runtimeModule && providesHold;
}

// starter meta v1 没有 scope 面、框架 bean 由编译器合成：两者恒为 singleton。
function isNonApplicationBean(
  bean: {
    readonly idParts: { readonly file: string; readonly exportName: string };
    readonly kind: "class" | "factory";
    readonly runtimeExport: ManifestExportReference;
    readonly provides: readonly ManifestSymbolReference[];
    readonly lifecycle: ManifestLifecycle;
  },
  origin: string,
  scope: "singleton" | "request",
  primary: boolean,
  qualifiers: readonly ManifestQualifier[],
): boolean {
  if (scope !== "singleton") {
    return false;
  }
  if (isFrameworkOrigin(origin)) {
    return isFrameworkBean(bean, origin, primary, qualifiers);
  }
  return isStarterBean(bean, origin);
}

// starter bean 的专属不变量：id 是 `包名#导出名`，runtimeExport 是包内的裸 specifier（生成的
// beans.ts 直接按包名 import），source 是发布包内的相对路径，因而不与 id 比对；M1 只有类构造
// 语义的 starter bean（ADR 0004 M1 范围，#145）。
function isStarterBean(
  bean: {
    readonly idParts: { readonly file: string; readonly exportName: string };
    readonly kind: "class" | "factory";
    readonly runtimeExport: ManifestExportReference;
    readonly provides: readonly ManifestSymbolReference[];
    readonly lifecycle: ManifestLifecycle;
  },
  origin: string,
): boolean {
  const packageName = starterOriginPackageName(origin);
  if (packageName === undefined || bean.idParts.file !== packageName) {
    return false;
  }
  const specifier = bean.runtimeExport.moduleSpecifier;
  const insidePackage = specifier === packageName || specifier.startsWith(`${packageName}/`);
  return (
    bean.kind === "class" &&
    !bean.lifecycle.dispose &&
    insidePackage &&
    bean.provides.some(
      (provided) =>
        provided.exportName === bean.runtimeExport.exportName &&
        !provided.moduleSpecifier.startsWith(".") &&
        (provided.moduleSpecifier === packageName ||
          provided.moduleSpecifier.startsWith(`${packageName}/`)),
    )
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

function isBeanScope(value: unknown): value is "singleton" | "request" {
  return value === "singleton" || value === "request";
}

// 请求 bean 没有 context 级生命周期，@Order 也不服务它（不能入集合），编译期都已拒绝；
// 产物字节可能被手改，此处按线上协议复检。
function requestScopeInvariantsHold(
  scope: unknown,
  lifecycle: ManifestLifecycle,
  order: unknown,
): boolean {
  if (scope !== "request") {
    return true;
  }
  return !lifecycle.start && !lifecycle.close && !lifecycle.dispose && order === undefined;
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

function isCollectionMember(value: unknown): value is ManifestCollectionMember {
  if (!isObject(value) || !hasExactKeys(value, ["targetId", "mode"])) {
    return false;
  }
  const mode = Reflect.get(value, "mode");
  return (
    beanIdParts(Reflect.get(value, "targetId")) !== undefined &&
    (mode === "eager" || mode === "cycle-proxy")
  );
}

function isCollectionDependency(value: object, index: number): boolean {
  if (!hasExactKeys(value, ["parameterIndex", "mode", "members", "source"])) {
    return false;
  }
  const members = Reflect.get(value, "members");
  if (
    Reflect.get(value, "parameterIndex") !== index ||
    !isArrayOf(members, (item, _memberIndex): item is ManifestCollectionMember =>
      isCollectionMember(item),
    ) ||
    !isSourceReference(Reflect.get(value, "source"))
  ) {
    return false;
  }
  const targets = members.map((member) => member.targetId);
  return new Set(targets).size === targets.length;
}

function isDependency(value: unknown, index: number): value is ManifestDependency {
  if (!isObject(value)) {
    return false;
  }
  if (Reflect.get(value, "mode") === "collection") {
    return isCollectionDependency(value, index);
  }
  if (!hasExactKeys(value, ["parameterIndex", "targetId", "mode", "source"])) {
    return false;
  }
  const mode = Reflect.get(value, "mode");
  return (
    Reflect.get(value, "parameterIndex") === index &&
    beanIdParts(Reflect.get(value, "targetId")) !== undefined &&
    (mode === "eager" ||
      mode === "cycle-proxy" ||
      mode === "explicit-lazy" ||
      mode === "current") &&
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
    !hasExactKeys(
      value,
      [
        "id",
        "origin",
        "kind",
        "scope",
        "source",
        "runtimeExport",
        "provides",
        "dependencies",
        "primary",
        "qualifiers",
        "lifecycle",
      ],
      ["order"],
    )
  ) {
    return false;
  }
  const order = Reflect.get(value, "order");
  if (order !== undefined && !Number.isInteger(order)) {
    return false;
  }
  const scope = Reflect.get(value, "scope");
  const id = Reflect.get(value, "id");
  const idParts = beanIdParts(id);
  const origin = Reflect.get(value, "origin");
  const kind = Reflect.get(value, "kind");
  const source = Reflect.get(value, "source");
  const runtimeExport = Reflect.get(value, "runtimeExport");
  const provides = Reflect.get(value, "provides");
  const dependencies = Reflect.get(value, "dependencies");
  const qualifiers = Reflect.get(value, "qualifiers");
  const lifecycle = Reflect.get(value, "lifecycle");
  // 框架 logger 是唯一「一个运行导出承载 N 个 bean 身份、且不提供任何契约」的形态，
  // 下面两条通用不变量对它不成立，交给 frameworkBeanSpecs 里的 logger spec 单独把关
  // （RFC 0011 L2，#242）。
  const loggerShaped = origin === loggingOriginId;
  if (
    idParts === undefined ||
    !isNonemptyString(origin) ||
    (kind !== "class" && kind !== "factory") ||
    !isSourceReference(source) ||
    !isExportReference(runtimeExport) ||
    (!loggerShaped && runtimeExport.exportName !== idParts.exportName) ||
    !isArrayOf(provides, isSymbolReference) ||
    (!loggerShaped && provides.length === 0) ||
    !hasUniqueSymbols(provides) ||
    !isArrayOf(dependencies, isDependency) ||
    typeof Reflect.get(value, "primary") !== "boolean" ||
    !isArrayOf(qualifiers, isQualifier) ||
    !hasValidQualifiers(qualifiers, provides) ||
    !isLifecycle(lifecycle) ||
    !isBeanScope(scope) ||
    !requestScopeInvariantsHold(scope, lifecycle, order)
  ) {
    return false;
  }
  if (origin !== "application") {
    return isNonApplicationBean(
      { idParts, kind, runtimeExport, provides, lifecycle },
      origin,
      scope,
      Reflect.get(value, "primary") === true,
      qualifiers,
    );
  }
  // 应用 bean：source.file 相对项目根且与 id 的 file 部分一致，runtimeExport 必须退回源码目录。
  if (
    source.file !== idParts.file ||
    !isRelativeRuntimeModuleSpecifier(runtimeExport.moduleSpecifier)
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

function isManifestConfig(value: unknown): value is ManifestConfig {
  if (!isObject(value) || !hasExactKeys(value, ["id", "prefix", "source", "provides"])) {
    return false;
  }
  const idParts = beanIdParts(Reflect.get(value, "id"));
  const prefix = Reflect.get(value, "prefix");
  const source = Reflect.get(value, "source");
  const provides = Reflect.get(value, "provides");
  return (
    idParts !== undefined &&
    typeof prefix === "string" &&
    configPrefixPattern.test(prefix) &&
    isSourceReference(source) &&
    // config 恒为应用侧声明：source.file 与 id 的 file 部分必须一致。
    source.file === idParts.file &&
    isArrayOf(provides, isSymbolReference) &&
    provides.length > 0 &&
    hasUniqueSymbols(provides)
  );
}

function isPlans(value: unknown): value is ManifestPlans {
  const keys = [
    "constructionOrder",
    "requestConstructionOrder",
    "startActionOrder",
    "cleanupActionOrder",
  ] as const;
  if (!isObject(value) || !hasExactKeys(value, keys)) {
    return false;
  }
  return keys.every((key) => isArrayOf(Reflect.get(value, key), isString));
}

function hasUniqueKnownIds(values: readonly string[], knownIds: ReadonlySet<string>): boolean {
  return values.every((id) => knownIds.has(id)) && new Set(values).size === values.length;
}

function exactlyCovers(values: readonly string[], expected: ReadonlySet<string>): boolean {
  return values.length === expected.size && values.every((id) => expected.has(id));
}

function hasEagerDependenciesConstructedFirst(
  order: readonly string[],
  beans: readonly ManifestBean[],
  alwaysReadyIds: ReadonlySet<string>,
): boolean {
  const constructionIndexes = new Map(order.map((id, index) => [id, index]));
  return beans.every((bean) => {
    const consumerIndex = constructionIndexes.get(bean.id);
    if (consumerIndex === undefined) {
      return false;
    }
    return bean.dependencies.every((dependency) =>
      manifestDependencyEdges(dependency).every((edge) => {
        if (edge.mode !== "eager") {
          return true;
        }
        // config 实例在绑定 phase 先于构造循环产生；请求计划里的 singleton 目标在请求开启前
        // 必然已构造——指向恒就绪目标的 eager 边不受计划位置约束。
        if (alwaysReadyIds.has(edge.targetId)) {
          return true;
        }
        const dependencyIndex = constructionIndexes.get(edge.targetId);
        return dependencyIndex !== undefined && dependencyIndex < consumerIndex;
      }),
    );
  });
}

// startActionOrder 与 cleanupActionOrder 都是同一条 lifecycleOrder 的过滤结果，cleanup 过滤的是它的
// 反序（compiler/src/analysis/execution-plan.ts 的 createExecutionPlans），因此两者共有的 bean 之间相对
// 次序必须互为倒序。能校验的只有这一条：完整次序在这里复算不出来——依赖环内成员按 id 排序，eager 依赖
// 可以合法地晚于消费者启动，把 constructionOrder 的偏序检查照搬过来会误杀所有含环的合法产物
//（Issue #104）。
function hasMirroredLifecycleOrder(plans: ManifestPlans): boolean {
  const startIds = new Set(plans.startActionOrder);
  const cleanupIds = new Set(plans.cleanupActionOrder);
  const startShared = plans.startActionOrder.filter((id) => cleanupIds.has(id));
  const cleanupShared = plans.cleanupActionOrder.filter((id) => startIds.has(id));
  return startShared.every((id, index) => id === cleanupShared[cleanupShared.length - 1 - index]);
}

// 跨作用域边规则（ADR 0006 W7，#151 / schema v4）镜像 compiler 的 scope-rules：current 只连
// singleton→request；到 request 目标的其余合法形态只有"request 消费者的 eager 单边"，集合
// 成员一律 singleton。
function hasValidScopeEdges(beans: readonly ManifestBean[]): boolean {
  const scopeById = new Map(beans.map((bean) => [bean.id, bean.scope]));
  return beans.every((bean) =>
    bean.dependencies.every((dependency) => {
      const collection = dependency.mode === "collection";
      return manifestDependencyEdges(dependency).every((edge) => {
        const targetScope = scopeById.get(edge.targetId);
        if (edge.mode === "current") {
          return bean.scope === "singleton" && targetScope === "request";
        }
        if (targetScope !== "request") {
          return true;
        }
        return !collection && bean.scope === "request" && edge.mode === "eager";
      });
    }),
  );
}

function hasValidPlans(
  plans: ManifestPlans,
  beans: readonly ManifestBean[],
  configIds: ReadonlySet<string>,
): boolean {
  // plans 的已知 id 只含 bean：config 不进任何计划数组（绑定 phase 不是计划驱动的）。
  const knownIds = new Set(beans.map((bean) => bean.id));
  const singletonIds = new Set(
    beans.flatMap((bean) => (bean.scope === "singleton" ? [bean.id] : [])),
  );
  const requestIds = new Set(beans.flatMap((bean) => (bean.scope === "request" ? [bean.id] : [])));
  if (
    !hasUniqueKnownIds(plans.constructionOrder, knownIds) ||
    !hasUniqueKnownIds(plans.requestConstructionOrder, knownIds) ||
    !hasUniqueKnownIds(plans.startActionOrder, knownIds) ||
    !hasUniqueKnownIds(plans.cleanupActionOrder, knownIds) ||
    !exactlyCovers(plans.constructionOrder, singletonIds) ||
    !exactlyCovers(plans.requestConstructionOrder, requestIds)
  ) {
    return false;
  }
  const singletonBeans = beans.filter((bean) => bean.scope === "singleton");
  const requestBeans = beans.filter((bean) => bean.scope === "request");
  if (!hasEagerDependenciesConstructedFirst(plans.constructionOrder, singletonBeans, configIds)) {
    return false;
  }
  if (
    !hasEagerDependenciesConstructedFirst(
      plans.requestConstructionOrder,
      requestBeans,
      new Set([...configIds, ...singletonIds]),
    )
  ) {
    return false;
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
  if (
    !exactlyCovers(plans.startActionOrder, expectedStart) ||
    !exactlyCovers(plans.cleanupActionOrder, expectedCleanup)
  ) {
    return false;
  }
  return hasMirroredLifecycleOrder(plans);
}

// 源路径的大小写不敏感冲突检测：macOS/Windows 默认文件系统上，仅大小写不同的两个文件会
// 互相覆盖，因此路径按 lowerCase 归一后必须唯一。compiler 编译期已拒绝此类冲突，此处对产物复检。
function registerSourcePath(
  namespace: string,
  source: ManifestSourceReference,
  portablePaths: Map<string, string>,
): boolean {
  const portable = `${namespace}\0${source.file.toLowerCase()}`;
  const existing = portablePaths.get(portable);
  if (existing !== undefined && existing !== source.file) {
    return false;
  }
  portablePaths.set(portable, source.file);
  return true;
}

// 大小写冲突检查按 origin 分命名空间：应用 bean 的路径相对项目根，starter bean 的路径相对各自
// 包根，跨命名空间的同名路径不是同一磁盘位置，不构成冲突。config 恒属应用命名空间。
function hasPortableSourcePaths(
  beans: readonly ManifestBean[],
  configs: readonly ManifestConfig[],
): boolean {
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
    if (sources.some((source) => !registerSourcePath(bean.origin, source, portablePaths))) {
      return false;
    }
  }
  for (const config of configs) {
    const sources = [
      config.source,
      ...config.provides.flatMap((provided) =>
        provided.declaration === undefined ? [] : [provided.declaration],
      ),
    ];
    if (sources.some((source) => !registerSourcePath("application", source, portablePaths))) {
      return false;
    }
  }
  return true;
}

function isGeneratedManifest(value: unknown): value is GeneratedManifest {
  // schemaVersion 是硬版本门：无法识别的 schema 直接拒绝，不按错版契约解释产物字节。
  // v2（ADR 0005，#130）新增顶层 configs；v3（ADR 0006 W6，#150）新增集合依赖形态与 bean 的
  // order 键；v4（ADR 0006 W7，#151）新增 bean 的 scope、current 依赖模式与
  // plans.requestConstructionOrder；与 compiler 的 renderManifest 同步演进。
  if (
    !isObject(value) ||
    !hasExactKeys(value, ["schemaVersion", "configs", "beans", "plans"]) ||
    Reflect.get(value, "schemaVersion") !== 5
  ) {
    return false;
  }
  const configs = Reflect.get(value, "configs");
  const beans = Reflect.get(value, "beans");
  const plans = Reflect.get(value, "plans");
  if (
    !isArrayOf(configs, isManifestConfig) ||
    !isArrayOf(beans, isManifestBean) ||
    !isPlans(plans)
  ) {
    return false;
  }
  const prefixes = configs.map((config) => config.prefix);
  if (new Set(prefixes).size !== prefixes.length) {
    return false;
  }
  // bean/config id 同一身份命名空间：除精确唯一外，按 lowerCase 归一后（portable id）也必须
  // 唯一，与 packages/context 的运行时校验互为双保险。
  const ids = [...beans.map((bean) => bean.id), ...configs.map((config) => config.id)];
  const portableIds = ids.map((id) => id.toLowerCase());
  const knownIds = new Set(ids);
  const configIds = new Set(configs.map((config) => config.id));
  if (
    knownIds.size !== ids.length ||
    new Set(portableIds).size !== portableIds.length ||
    !hasPortableSourcePaths(beans, configs) ||
    beans.some((bean) =>
      bean.dependencies.some((dependency) =>
        manifestDependencyEdges(dependency).some((edge) => !knownIds.has(edge.targetId)),
      ),
    )
  ) {
    return false;
  }
  if (!hasValidScopeEdges(beans)) {
    return false;
  }
  return hasValidPlans(plans, beans, configIds);
}

export function parseGeneratedManifestBytes(bytes: Uint8Array): GeneratedManifest | undefined {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isGeneratedManifest(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function validateGeneratedManifestBytes(bytes: Uint8Array): boolean {
  return parseGeneratedManifestBytes(bytes) !== undefined;
}
