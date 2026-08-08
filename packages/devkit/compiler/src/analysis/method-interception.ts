import { compareUtf16CodeUnits } from "@reforce/primitives";
import { claimRoleBean } from "@/analysis/bean-roles";
import {
  chainFieldNameFor,
  compareChainEntries,
  type InterceptorBinding,
  type InterceptorChainEntryModel,
  type InterceptPhaseModel,
  interceptPhaseOrder,
  type MethodMetaValueModel,
  type WeavingModel,
  type WovenBeanModel,
  type WovenMethodModel,
} from "@/analysis/interception-model";
import { markerUseValueOf } from "@/analysis/marker-value";
import { type ProviderModel, providerId, sourceReference } from "@/analysis/model";
import { transactionalMarkerKey, validateTransactionalValue } from "@/analysis/transaction-weaving";
import type { CompilerDiagnostic } from "@/api";
import { diagnostic } from "@/diagnostics";
import type { LinkedSymbol } from "@/linking/model";
import type { ProjectLinker } from "@/linking/project-linker";
import type {
  ClassDeclaration,
  ClassMethodDeclaration,
  DecoratorArgumentValue,
  DecoratorUse,
  ObjectLiteralProperty,
  ValueDeclaration,
} from "@/parser/source-ir";
import type { SourceSpan } from "@/parser/source-location";
import type { ParsedSource } from "@/project/source-files";

// 方法级织入分析（ADR 0008 AM1，#202）：标记声明与使用、@Interceptor 绑定、链压平与
// 构造依赖边追加。通道形状平行转写 web-routes 的 marker 通道（定案 2：web 依赖 context，
// 不反向复用；Rule of Three 第二次出现保持重复）。三条底线：编译期整图校验、确定性输出、
// 哑运行时——任何静态提取不了、织不进去的形态都在这里硬错，无静默第三态。

const markerDeclarationHelp =
  'Declare method markers as export const X = defineMethodMarker<T>("key") with a non-empty string literal key.';
const interceptorHelp =
  "Declare interceptors as @Interceptor({ marker, phase?, order? }) singleton classes.";

function report(
  diagnostics: CompilerDiagnostic[],
  code: CompilerDiagnostic["code"],
  message: string,
  span: SourceSpan,
  options: { readonly help?: string; readonly related?: CompilerDiagnostic["related"] } = {},
): void {
  diagnostics.push(
    diagnostic({
      code,
      message,
      sourceSpan: span,
      help: options.help,
      related: options.related,
    }),
  );
}

interface MethodMarkerDeclarationInfo {
  readonly key: string;
  readonly span: SourceSpan;
}

interface CollectedMethodMarker {
  readonly registryKey: string;
  readonly fileId: string;
  readonly name: string;
  readonly info: MethodMarkerDeclarationInfo;
}

function markerRegistryKey(fileId: string, localName: string): string {
  return `${fileId}#${localName}`;
}

// marker 声明规则同 route marker 口径（#202 硬错 #1）：顶层 const、直接调用
// defineMethodMarker、key 是非空字符串字面量；命中但形状非法原位硬错，不静默跳过（#54）。
function methodMarkerDeclarationOf(
  source: ParsedSource,
  declaration: ValueDeclaration,
  linker: ProjectLinker,
  diagnostics: CompilerDiagnostic[],
): CollectedMethodMarker | undefined {
  const initializer = declaration.initializer;
  if (initializer?.kind !== "call") {
    return undefined;
  }
  const callee = linker.resolveEntity(source, initializer.callee);
  if (callee?.kind !== "core" || callee.name !== "defineMethodMarker") {
    return undefined;
  }
  if (
    !declaration.topLevel ||
    declaration.declarationKind !== "const" ||
    declaration.name === undefined
  ) {
    report(
      diagnostics,
      "INVALID_METHOD_MARKER",
      "defineMethodMarker must initialize a top-level const with a single name.",
      declaration.span,
      { help: markerDeclarationHelp },
    );
    return undefined;
  }
  const argument = initializer.arguments.at(0);
  if (
    initializer.arguments.length !== 1 ||
    argument?.kind !== "string-literal" ||
    argument.value.length === 0
  ) {
    report(
      diagnostics,
      "INVALID_METHOD_MARKER",
      `Method marker ${declaration.name} needs exactly one non-empty string literal key.`,
      argument?.span ?? initializer.span,
      { help: markerDeclarationHelp },
    );
    return undefined;
  }
  // 保留 key（ADR 0008 AM2，#204 定案 2）：裸词 "transactional" 恒指框架的 @Transactional，
  // 用户同名声明会让织入表与 explain 输出出现两义，原位硬错。
  if (argument.value === transactionalMarkerKey) {
    report(
      diagnostics,
      "INVALID_METHOD_MARKER",
      `Method marker key "${transactionalMarkerKey}" is reserved by the framework's @Transactional marker.`,
      argument.span,
      {
        help: "Choose a different marker key; bind extra behavior to transactional methods with @Interceptor({ marker: Transactional }).",
        related: [{ message: "reserved by @reforce/transaction Transactional" }],
      },
    );
    return undefined;
  }
  return {
    registryKey: markerRegistryKey(source.fileId, declaration.name),
    fileId: source.fileId,
    name: declaration.name,
    info: { key: argument.value, span: declaration.span },
  };
}

// key 空间是全局的（#284，同 #254 的 route marker）：织入表按裸字符串 key 存，两个声明撞 key
// 时互为别名，绑到 A 的拦截器会对 B 标记的方法生效。排序让首见者与报错顺序确定；报错后
// 注册表保留全部声明，使用侧不再连带报错。
function reportDuplicateMarkerKeys(
  collected: readonly CollectedMethodMarker[],
  diagnostics: CompilerDiagnostic[],
): void {
  const firstByKey = new Map<string, CollectedMethodMarker>();
  const ordered = collected.toSorted((left, right) => {
    const file = compareUtf16CodeUnits(left.fileId, right.fileId);
    return file === 0 ? left.info.span.start.offset - right.info.span.start.offset : file;
  });
  for (const marker of ordered) {
    const first = firstByKey.get(marker.info.key);
    if (first === undefined) {
      firstByKey.set(marker.info.key, marker);
      continue;
    }
    report(
      diagnostics,
      "DUPLICATE_METHOD_MARKER",
      `Method marker key ${JSON.stringify(marker.info.key)} is already declared by ${first.name}.`,
      marker.info.span,
      {
        help: "Give each method marker a globally unique key.",
        related: [{ message: first.name, sourceSpan: first.info.span }],
      },
    );
  }
}

function collectMethodMarkers(
  sources: readonly ParsedSource[],
  linker: ProjectLinker,
  diagnostics: CompilerDiagnostic[],
): ReadonlyMap<string, MethodMarkerDeclarationInfo> {
  const collected: CollectedMethodMarker[] = [];
  for (const source of sources) {
    if (source.sourceKind.startsWith("d.")) {
      continue;
    }
    for (const declaration of source.unit.valueDeclarations) {
      const entry = methodMarkerDeclarationOf(source, declaration, linker, diagnostics);
      if (entry !== undefined) {
        collected.push(entry);
      }
    }
  }
  reportDuplicateMarkerKeys(collected, diagnostics);
  return new Map(collected.map((marker) => [marker.registryKey, marker.info]));
}

// marker 使用识别（markerUseOf 同款）：callee 解析不到已链接符号、却能落到
// defineMethodMarker 声明的装饰器才算标记；其余解析不到的装饰器不属于 Reforce，保持沉默。
// 框架标记 @Transactional 是唯一例外（#204 定案 2）：它解析成 transaction 合成符号、没有源内
// 声明，落到保留 key，此后与用户标记走完全同一通道（硬错矩阵、织入表、链压平零特权）。
function markerUseOf(
  source: ParsedSource,
  decorator: DecoratorUse,
  markers: ReadonlyMap<string, MethodMarkerDeclarationInfo>,
  linker: ProjectLinker,
): MethodMarkerDeclarationInfo | undefined {
  if (decorator.callee.kind === "unsupported-expression") {
    return undefined;
  }
  const entitySymbol = linker.resolveEntity(source, decorator.callee);
  if (entitySymbol !== undefined) {
    return entitySymbol.kind === "transaction" && entitySymbol.name === "Transactional"
      ? { key: transactionalMarkerKey, span: decorator.span }
      : undefined;
  }
  // 注册表为空时零成本短路：无标记的项目不为每个装饰器付一次声明解析。
  if (markers.size === 0 || decorator.callee.kind !== "identifier") {
    return undefined;
  }
  const resolved = linker.resolveValueDeclaration(source, decorator.callee.name);
  if (resolved?.declaration.name === undefined) {
    return undefined;
  }
  return markers.get(markerRegistryKey(resolved.source.fileId, resolved.declaration.name));
}

interface MarkerUse {
  readonly span: SourceSpan;
  readonly declarationSpan: SourceSpan;
  readonly value: MethodMetaValueModel | null;
}

interface MarkedMethodScan {
  readonly method: ClassMethodDeclaration;
  // 插入序即源码书写序：链压平的去重首现以它为准（确定性输入）。
  readonly markers: ReadonlyMap<string, MarkerUse>;
}

interface MarkedClassScan {
  readonly source: ParsedSource;
  readonly declaration: ClassDeclaration;
  readonly methods: readonly MarkedMethodScan[];
  // 本类任何标记/方法形状/认领错误都会翻掉它：出错的 bean 不产出织入数据（编译已然失败）。
  valid: boolean;
}

// 同方法同标记重复是硬错双侧定位（#202 硬错 #6，routeMetaOf 同款）。
function markedMethodOf(
  source: ParsedSource,
  method: ClassMethodDeclaration,
  markers: ReadonlyMap<string, MethodMarkerDeclarationInfo>,
  linker: ProjectLinker,
  diagnostics: CompilerDiagnostic[],
): { readonly scan: MarkedMethodScan; readonly valid: boolean } | undefined {
  const uses = new Map<string, MarkerUse>();
  let valid = true;
  for (const decorator of method.decorators) {
    const marker = markerUseOf(source, decorator, markers, linker);
    if (marker === undefined) {
      continue;
    }
    const value = markerUseValueOf(decorator, diagnostics);
    if (value === undefined) {
      valid = false;
      continue;
    }
    // 框架标记的参数 schema 编译期钉死（#204 定案 2）：传播/隔离拼写错在这里硬错，
    // 织入表里只存在合法值，运行时按表执行零决策（ADR 0008 不变量 4）。
    if (
      marker.key === transactionalMarkerKey &&
      !validateTransactionalValue(value, decorator.span, diagnostics)
    ) {
      valid = false;
      continue;
    }
    const first = uses.get(marker.key);
    if (first !== undefined) {
      report(
        diagnostics,
        "INVALID_METHOD_MARKER_VALUE",
        `Method marker key ${JSON.stringify(marker.key)} appears twice on the same method.`,
        decorator.span,
        { related: [{ message: marker.key, sourceSpan: first.span }] },
      );
      valid = false;
      continue;
    }
    uses.set(marker.key, { span: decorator.span, declarationSpan: marker.span, value });
  }
  if (uses.size === 0 && valid) {
    return undefined;
  }
  return { scan: { method, markers: uses }, valid };
}

// 被织方法的形状闭集（#202 硬错 #3/#4）：public 实例方法实现、identifier 名、非 generator/
// optional/overload 签名；且必须 async——织入链是异步洋葱，同步方法被织入后签名撒谎，
// 正是要消灭的静默第三态。
function validWovenMethod(
  method: ClassMethodDeclaration,
  className: string,
  diagnostics: CompilerDiagnostic[],
): string | undefined {
  const name = method.name.kind === "identifier" ? method.name.name : undefined;
  if (
    name === undefined ||
    method.static ||
    method.accessibility !== "public" ||
    method.generator ||
    method.optional ||
    !method.implementation
  ) {
    report(
      diagnostics,
      "INVALID_METHOD_MARKER",
      `A marked method on ${className} must be a public instance method implementation with an identifier name.`,
      method.span,
    );
    return undefined;
  }
  if (!method.async) {
    report(
      diagnostics,
      "INVALID_METHOD_MARKER",
      `Marked method ${name} on ${className} must be async: the woven interceptor chain is asynchronous and would turn a sync return into a Promise.`,
      method.span,
      { help: "Declare the marked method with the async keyword." },
    );
    return undefined;
  }
  return name;
}

// 类位置双保险（#202 硬错 #5）：类型层 ClassMethodDecoratorContext 已拒，编译层命中再拒。
function reportClassLevelMarkerUses(
  source: ParsedSource,
  declaration: ClassDeclaration,
  markers: ReadonlyMap<string, MethodMarkerDeclarationInfo>,
  linker: ProjectLinker,
  diagnostics: CompilerDiagnostic[],
): void {
  for (const decorator of declaration.decorators) {
    const marker = markerUseOf(source, decorator, markers, linker);
    if (marker !== undefined) {
      report(
        diagnostics,
        "INVALID_METHOD_MARKER",
        `Method marker ${JSON.stringify(marker.key)} cannot mark a class; apply it to individual methods.`,
        decorator.span,
      );
    }
  }
}

// 织入换构造（#202 硬错 #2）：$Woven 经 create 改写换入，因此被织类必须是 @Injectable 类
// provider——defineBean 工厂自己 new，实例无从替换。request-scoped 合法（constructRequest
// 路径同样吃 create 改写）。
function claimWovenBean(
  source: ParsedSource,
  declaration: ClassDeclaration,
  providerById: ReadonlyMap<string, ProviderModel>,
  diagnostics: CompilerDiagnostic[],
): ProviderModel | undefined {
  const exportName = declaration.name;
  const beanId = exportName === undefined ? undefined : providerId(source.fileId, exportName);
  const provider = beanId === undefined ? undefined : providerById.get(beanId);
  if (provider === undefined || provider.kind !== "class") {
    report(
      diagnostics,
      "INVALID_METHOD_MARKER",
      `${exportName ?? "A class"} with marked methods must be an @Injectable() class provider: weaving replaces construction, and factory-provided instances cannot be swapped for the woven subclass.`,
      declaration.span,
      {
        help: "Mark the class @Injectable(); defineBean factories construct instances themselves.",
      },
    );
    return undefined;
  }
  return provider;
}

function coreDecoratorsNamed(
  source: ParsedSource,
  decorators: readonly DecoratorUse[],
  name: string,
  linker: ProjectLinker,
): readonly DecoratorUse[] {
  return decorators.filter((decorator) => {
    if (decorator.callee.kind === "unsupported-expression") {
      return false;
    }
    const symbol = linker.resolveEntity(source, decorator.callee);
    return symbol?.kind === "core" && symbol.name === name;
  });
}

function isInterceptPhaseModel(value: string): value is InterceptPhaseModel {
  return (interceptPhaseOrder as readonly string[]).includes(value);
}

type MarkerReference = Extract<DecoratorArgumentValue, { readonly kind: "identifier-reference" }>;

interface InterceptorOptionsDraft {
  readonly marker?: MarkerReference;
  readonly phase: InterceptPhaseModel;
  readonly order: number;
}

interface ResolvedInterceptorOptions extends InterceptorOptionsDraft {
  readonly marker: MarkerReference;
}

// 选项键表驱动（middlewareOptionParsers 同款，#202 硬错 #8）：parse 返回 undefined 即值
// 形态非法，message 是对应的点名文案。
const interceptorOptionParsers = {
  marker: {
    message: "Interceptor marker must be a plain identifier referencing a method marker.",
    parse: (value: DecoratorArgumentValue, options: InterceptorOptionsDraft) =>
      value.kind === "identifier-reference" ? { ...options, marker: value } : undefined,
  },
  phase: {
    message: `Interceptor phase must be one of ${interceptPhaseOrder
      .map((phase) => JSON.stringify(phase))
      .join(", ")}.`,
    parse: (value: DecoratorArgumentValue, options: InterceptorOptionsDraft) =>
      value.kind === "string-literal" && isInterceptPhaseModel(value.value)
        ? { ...options, phase: value.value }
        : undefined,
  },
  order: {
    message: "Interceptor order must be an integer literal.",
    parse: (value: DecoratorArgumentValue, options: InterceptorOptionsDraft) =>
      value.kind === "number-literal" && Number.isInteger(value.value)
        ? { ...options, order: value.value }
        : undefined,
  },
} as const;

function interceptorOptionOf(
  property: ObjectLiteralProperty,
  options: InterceptorOptionsDraft,
  diagnostics: CompilerDiagnostic[],
): InterceptorOptionsDraft | undefined {
  if (property.kind === "unsupported-property") {
    report(
      diagnostics,
      "INVALID_INTERCEPTOR_DECLARATION",
      `Interceptor options cannot use ${property.propertyKind} properties.`,
      property.span,
    );
    return undefined;
  }
  if (!Object.hasOwn(interceptorOptionParsers, property.key)) {
    report(
      diagnostics,
      "INVALID_INTERCEPTOR_DECLARATION",
      `Interceptor options do not include "${property.key}".`,
      property.span,
    );
    return undefined;
  }
  // Object.hasOwn 已证明成员资格，索引签名推不回字面量联合 // justified: 见上一行
  const parser = interceptorOptionParsers[property.key as keyof typeof interceptorOptionParsers];
  const parsed = parser.parse(property.value, options);
  if (parsed === undefined) {
    report(diagnostics, "INVALID_INTERCEPTOR_DECLARATION", parser.message, property.span);
    return undefined;
  }
  return parsed;
}

function interceptorOptionsOf(
  decorator: DecoratorUse,
  diagnostics: CompilerDiagnostic[],
): ResolvedInterceptorOptions | undefined {
  const argument = decorator.arguments.at(0);
  if (decorator.arguments.length !== 1 || argument?.kind !== "object-literal") {
    report(
      diagnostics,
      "INVALID_INTERCEPTOR_DECLARATION",
      "Interceptor accepts one object literal of options with a marker reference.",
      argument?.span ?? decorator.span,
      { help: interceptorHelp },
    );
    return undefined;
  }
  let options: InterceptorOptionsDraft | undefined = { phase: "application", order: 0 };
  for (const property of argument.properties) {
    options = interceptorOptionOf(property, options, diagnostics);
    if (options === undefined) {
      return undefined;
    }
  }
  const marker = options.marker;
  if (marker === undefined) {
    report(
      diagnostics,
      "INVALID_INTERCEPTOR_DECLARATION",
      "Interceptor options require a marker reference.",
      argument.span,
      { help: interceptorHelp },
    );
    return undefined;
  }
  return { ...options, marker };
}

// marker 引用与 marker 使用同通道（resolveValueDeclaration 落声明注册表）；解析到其他已
// 链接符号或落不进注册表都是硬错（#202 硬错 #8）。框架标记同通道（#204 定案 2）：
// @Interceptor({ marker: Transactional }) 让用户拦截器挂上事务方法（观测类的第一方场景）。
function interceptorMarkerKeyOf(
  source: ParsedSource,
  reference: MarkerReference,
  markers: ReadonlyMap<string, MethodMarkerDeclarationInfo>,
  linker: ProjectLinker,
  diagnostics: CompilerDiagnostic[],
): string | undefined {
  const entity = reference.entity;
  const entitySymbol =
    entity.kind === "identifier" ? linker.resolveEntity(source, entity) : undefined;
  if (entitySymbol?.kind === "transaction" && entitySymbol.name === "Transactional") {
    return transactionalMarkerKey;
  }
  const resolved =
    entity.kind === "identifier" && entitySymbol === undefined
      ? linker.resolveValueDeclaration(source, entity.name)
      : undefined;
  const info =
    resolved?.declaration.name === undefined
      ? undefined
      : markers.get(markerRegistryKey(resolved.source.fileId, resolved.declaration.name));
  if (info === undefined) {
    report(
      diagnostics,
      "INVALID_INTERCEPTOR_DECLARATION",
      "Interceptor marker must reference a defineMethodMarker declaration.",
      reference.span,
      { help: markerDeclarationHelp },
    );
    return undefined;
  }
  return info.key;
}

// 拦截器 bean 认领：bean 身份、singleton 约束与 @Injectable 共存拒绝都由 @Interceptor 这个
// 角色装饰器在 class-provider 一处判定（bean-roles.ts），这里只补织入侧要用的契约符号。
function claimInterceptorBean(
  source: ParsedSource,
  declaration: ClassDeclaration,
  providerById: ReadonlyMap<string, ProviderModel>,
  linker: ProjectLinker,
  diagnostics: CompilerDiagnostic[],
): { readonly beanId: string; readonly contract: LinkedSymbol } | undefined {
  const claim = claimRoleBean(source, declaration, "interceptor", providerById, diagnostics);
  if (claim === undefined) {
    return undefined;
  }
  const contract = linker.symbolForDeclaration(source, declaration);
  if (contract === undefined) {
    throw new Error(`Missing linked symbol for interceptor ${claim.beanId}`);
  }
  return { beanId: claim.beanId, contract };
}

function interceptorBindingOf(
  source: ParsedSource,
  declaration: ClassDeclaration,
  linker: ProjectLinker,
  markers: ReadonlyMap<string, MethodMarkerDeclarationInfo>,
  providerById: ReadonlyMap<string, ProviderModel>,
  diagnostics: CompilerDiagnostic[],
): InterceptorBinding | undefined {
  const decorators = coreDecoratorsNamed(source, declaration.decorators, "Interceptor", linker);
  const first = decorators.at(0);
  if (first === undefined) {
    return undefined;
  }
  if (decorators.length !== 1 || !first.called) {
    report(
      diagnostics,
      "INVALID_INTERCEPTOR_DECLARATION",
      "Interceptor must appear at most once as @Interceptor({ ... }).",
      first.span,
    );
    return undefined;
  }
  const options = interceptorOptionsOf(first, diagnostics);
  const claim = claimInterceptorBean(source, declaration, providerById, linker, diagnostics);
  const markerKey =
    options === undefined
      ? undefined
      : interceptorMarkerKeyOf(source, options.marker, markers, linker, diagnostics);
  if (options === undefined || claim === undefined || markerKey === undefined) {
    return undefined;
  }
  return {
    beanId: claim.beanId,
    phase: options.phase,
    order: options.order,
    markerKey,
    contract: claim.contract,
  };
}

function collectInterceptorBindings(
  sources: readonly ParsedSource[],
  linker: ProjectLinker,
  markers: ReadonlyMap<string, MethodMarkerDeclarationInfo>,
  providerById: ReadonlyMap<string, ProviderModel>,
  diagnostics: CompilerDiagnostic[],
): ReadonlyMap<string, readonly InterceptorBinding[]> {
  const bindings = new Map<string, InterceptorBinding[]>();
  for (const source of sources) {
    if (source.sourceKind.startsWith("d.")) {
      continue;
    }
    for (const declaration of source.unit.classes) {
      const binding = interceptorBindingOf(
        source,
        declaration,
        linker,
        markers,
        providerById,
        diagnostics,
      );
      if (binding === undefined) {
        continue;
      }
      const existing = bindings.get(binding.markerKey) ?? [];
      existing.push(binding);
      bindings.set(binding.markerKey, existing);
    }
  }
  return bindings;
}

// @Interceptor 只有类位置（词汇闭合的另一半）：方法位命中原位拒绝，不静默忽略。
function reportMethodLevelInterceptorUses(
  source: ParsedSource,
  method: ClassMethodDeclaration,
  linker: ProjectLinker,
  diagnostics: CompilerDiagnostic[],
): void {
  const misplaced = coreDecoratorsNamed(source, method.decorators, "Interceptor", linker).at(0);
  if (misplaced !== undefined) {
    report(
      diagnostics,
      "INVALID_INTERCEPTOR_DECLARATION",
      "Interceptor cannot mark a method; it binds an interceptor class to a marker.",
      misplaced.span,
    );
  }
}

function scanMarkedClasses(
  sources: readonly ParsedSource[],
  linker: ProjectLinker,
  markers: ReadonlyMap<string, MethodMarkerDeclarationInfo>,
  diagnostics: CompilerDiagnostic[],
): readonly MarkedClassScan[] {
  const scans: MarkedClassScan[] = [];
  for (const source of sources) {
    if (source.sourceKind.startsWith("d.")) {
      continue;
    }
    for (const declaration of source.unit.classes) {
      reportClassLevelMarkerUses(source, declaration, markers, linker, diagnostics);
      const methods: MarkedMethodScan[] = [];
      let valid = true;
      for (const method of declaration.methods) {
        reportMethodLevelInterceptorUses(source, method, linker, diagnostics);
        const marked = markedMethodOf(source, method, markers, linker, diagnostics);
        if (marked === undefined) {
          continue;
        }
        valid &&= marked.valid;
        methods.push(marked.scan);
      }
      if (methods.length > 0) {
        scans.push({ source, declaration, methods, valid });
      }
    }
  }
  return scans;
}

interface ResolvedHeritage {
  readonly source: ParsedSource;
  readonly declaration: ClassDeclaration;
}

function heritageClassOf(
  source: ParsedSource,
  declaration: ClassDeclaration,
  linker: ProjectLinker,
): ResolvedHeritage | undefined {
  const heritage = declaration.heritage;
  if (heritage?.kind !== "reference") {
    return undefined;
  }
  const symbol = linker.resolveEntity(source, heritage.entity);
  if (
    symbol?.kind !== "class" ||
    symbol.declaration?.kind !== "class" ||
    symbol.source === undefined
  ) {
    return undefined;
  }
  return { source: symbol.source, declaration: symbol.declaration };
}

// override 丢标记硬错（#202 硬错 #9，定案 3）：标记只按 bean 类自身声明的方法收集，子类
// override 掉父类被标记方法而未重申同一标记即静默丢织入——双侧定位，要求显式重申或改名。
function reportOverrideDroppedMarkers(
  sources: readonly ParsedSource[],
  linker: ProjectLinker,
  scans: readonly MarkedClassScan[],
  providerById: ReadonlyMap<string, ProviderModel>,
  diagnostics: CompilerDiagnostic[],
): void {
  const scanByDeclaration = new Map(scans.map((scan) => [scan.declaration, scan]));
  for (const source of sources) {
    if (source.sourceKind.startsWith("d.")) {
      continue;
    }
    for (const declaration of source.unit.classes) {
      const beanId =
        declaration.name === undefined ? undefined : providerId(source.fileId, declaration.name);
      if (beanId === undefined || providerById.get(beanId)?.kind !== "class") {
        continue;
      }
      reportDroppedMarkersOnBean(source, declaration, linker, scanByDeclaration, diagnostics);
    }
  }
}

interface OwnMemberIndex {
  readonly methods: ReadonlyMap<string, ClassMethodDeclaration>;
  readonly markers: ReadonlyMap<string, ReadonlyMap<string, MarkerUse>>;
}

function ownMemberIndexOf(
  declaration: ClassDeclaration,
  scanByDeclaration: ReadonlyMap<ClassDeclaration, MarkedClassScan>,
): OwnMemberIndex {
  const methods = new Map<string, ClassMethodDeclaration>();
  const markers = new Map<string, ReadonlyMap<string, MarkerUse>>();
  for (const method of declaration.methods) {
    if (method.name.kind === "identifier" && method.implementation) {
      methods.set(method.name.name, method);
    }
  }
  for (const marked of scanByDeclaration.get(declaration)?.methods ?? []) {
    if (marked.method.name.kind === "identifier") {
      markers.set(marked.method.name.name, marked.markers);
    }
  }
  return { methods, markers };
}

function reportDroppedMarkersForOverride(
  declaration: ClassDeclaration,
  own: OwnMemberIndex,
  parent: ResolvedHeritage,
  parentMethod: MarkedMethodScan,
  diagnostics: CompilerDiagnostic[],
): void {
  if (parentMethod.method.name.kind !== "identifier") {
    return;
  }
  const methodName = parentMethod.method.name.name;
  const override = own.methods.get(methodName);
  if (override === undefined) {
    return;
  }
  const restated = own.markers.get(methodName);
  for (const [markerKey, use] of parentMethod.markers) {
    if (restated?.has(markerKey) === true) {
      continue;
    }
    report(
      diagnostics,
      "INVALID_METHOD_MARKER",
      `${declaration.name ?? "A subclass"}.${methodName} overrides a method marked ${JSON.stringify(markerKey)} on ${parent.declaration.name ?? "its base class"} without restating the marker.`,
      override.span,
      {
        related: [{ message: markerKey, sourceSpan: use.span }],
        help: "Restate the marker on the override or rename the method; weaving only reads markers declared on the Bean class itself.",
      },
    );
  }
}

function reportDroppedMarkersOnBean(
  source: ParsedSource,
  declaration: ClassDeclaration,
  linker: ProjectLinker,
  scanByDeclaration: ReadonlyMap<ClassDeclaration, MarkedClassScan>,
  diagnostics: CompilerDiagnostic[],
): void {
  const own = ownMemberIndexOf(declaration, scanByDeclaration);
  const visited = new Set<ClassDeclaration>([declaration]);
  let parent = heritageClassOf(source, declaration, linker);
  while (parent !== undefined && !visited.has(parent.declaration)) {
    visited.add(parent.declaration);
    for (const parentMethod of scanByDeclaration.get(parent.declaration)?.methods ?? []) {
      reportDroppedMarkersForOverride(declaration, own, parent, parentMethod, diagnostics);
    }
    parent = heritageClassOf(parent.source, parent.declaration, linker);
  }
}

export interface ChainEntryDraft {
  readonly beanId: string;
  readonly phase: InterceptPhaseModel;
  readonly order: number;
  readonly markerKey: string;
  readonly value: MethodMetaValueModel | null;
}

// 链压平（#202 定案 3）：按 (阶段, order, beanId) 排序写死。同一 beanId 出现两次在 v1 是
// 结构上不可达的——一个拦截器类只能有一个 @Interceptor、只绑一个 marker；同方法同 marker
// 重复已在 markedMethodOf 硬错；beanId 全局唯一。因此这里是不变量断言而不是去重：原先的
// "首现取值"顺手定死了叠加语义，将来真放开一个拦截器绑多个 marker 时会静默丢弃第二个
// value——那条规则必须在放开的那一刻正面定案，不得继承此处的默认值。
//
// 类级标记落地不会让它变可达：类级 + 方法级叠加同一 marker 时，冲突发生在 markedMethodOf
// 的 Map<markerKey, MarkerUse> 层，产出仍是每 markerKey 一个合并后的 value。未来要定的
// 合并规则在那个位置，不在这里。
export function flattenChainEntries(
  entries: readonly ChainEntryDraft[],
): readonly ChainEntryDraft[] {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.beanId)) {
      throw new Error(`Duplicate interceptor ${entry.beanId} on one method chain`);
    }
    seen.add(entry.beanId);
  }
  return entries.toSorted(compareChainEntries);
}

function nextParameterIndex(provider: ProviderModel): number {
  return provider.dependencies.reduce(
    (next, dependency) => Math.max(next, dependency.parameterIndex + 1),
    0,
  );
}

function memberNamesOf(declaration: ClassDeclaration): ReadonlySet<string> {
  const names = new Set<string>();
  for (const field of declaration.fields) {
    if (field.name !== undefined) {
      names.add(field.name);
    }
  }
  for (const method of declaration.methods) {
    if (method.name.kind === "identifier") {
      names.add(method.name.name);
    }
  }
  return names;
}

interface WovenBeanDraft {
  readonly scan: MarkedClassScan;
  readonly provider: ProviderModel;
  readonly methods: readonly { readonly name: string; readonly scan: MarkedMethodScan }[];
}

function wovenBeanModelOf(
  draft: WovenBeanDraft,
  bindings: ReadonlyMap<string, readonly InterceptorBinding[]>,
): WovenBeanModel {
  const interceptorByBeanId = new Map<string, InterceptorBinding>();
  const firstUseSpanByBeanId = new Map<string, SourceSpan>();
  const flattenedByMethod = new Map<string, readonly ChainEntryDraft[]>();
  for (const method of draft.methods) {
    const drafts: ChainEntryDraft[] = [];
    for (const [markerKey, use] of method.scan.markers) {
      for (const binding of bindings.get(markerKey) ?? []) {
        drafts.push({
          beanId: binding.beanId,
          phase: binding.phase,
          order: binding.order,
          markerKey,
          value: use.value,
        });
        if (!interceptorByBeanId.has(binding.beanId)) {
          interceptorByBeanId.set(binding.beanId, binding);
          firstUseSpanByBeanId.set(binding.beanId, use.span);
        }
      }
    }
    flattenedByMethod.set(method.name, flattenChainEntries(drafts));
  }

  // 追加构造依赖边（#202 定案 5）：去重拦截器按 beanId 排序，parameterIndex 从用户参数后
  // 顺延；mode eager 走既有构造排序 / cycle-proxy / request 计划，registration 无新槽位，
  // context definition 保持 v4。
  const start = nextParameterIndex(draft.provider);
  const orderedInterceptors = [...interceptorByBeanId.values()].toSorted((left, right) =>
    compareUtf16CodeUnits(left.beanId, right.beanId),
  );
  const parameterIndexByBeanId = new Map<string, number>();
  orderedInterceptors.forEach((binding, offset) => {
    const parameterIndex = start + offset;
    parameterIndexByBeanId.set(binding.beanId, parameterIndex);
    const useSpan = firstUseSpanByBeanId.get(binding.beanId);
    if (useSpan === undefined) {
      throw new Error(`Missing marker use span for interceptor ${binding.beanId}`);
    }
    draft.provider.dependencies.push({
      parameterIndex,
      targetId: binding.beanId,
      mode: "eager",
      source: sourceReference(useSpan),
      contract: binding.contract,
    });
  });

  const methods: WovenMethodModel[] = draft.methods
    .map(({ name, scan }) => {
      const chain: InterceptorChainEntryModel[] = (flattenedByMethod.get(name) ?? []).map(
        (entry) => {
          const parameterIndex = parameterIndexByBeanId.get(entry.beanId);
          if (parameterIndex === undefined) {
            throw new Error(`Missing parameter index for interceptor ${entry.beanId}`);
          }
          return { ...entry, parameterIndex };
        },
      );
      const markers = new Map<string, MethodMetaValueModel | null>();
      for (const [markerKey, use] of scan.markers) {
        markers.set(markerKey, use.value);
      }
      return { method: name, markers, chain };
    })
    .toSorted((left, right) => compareUtf16CodeUnits(left.method, right.method));

  return {
    beanId: draft.provider.id,
    chainFieldName: chainFieldNameFor(memberNamesOf(draft.scan.declaration)),
    methods,
  };
}

// 贡献进来的绑定只在它的 bean 真进了图时生效：合成 provider 的存在即证明那个能力真的被用到了
// （事务那条即「有 @Transactional 使用」）。用户经 @Interceptor({ marker: … }) 绑的拦截器与它
// 同链参与压平。
function mergeContributedBindings(
  declared: ReadonlyMap<string, readonly InterceptorBinding[]>,
  contributed: readonly InterceptorBinding[],
  providerById: ReadonlyMap<string, ProviderModel>,
): ReadonlyMap<string, readonly InterceptorBinding[]> {
  const merged = new Map(declared);
  for (const binding of contributed) {
    if (!providerById.has(binding.beanId)) {
      continue;
    }
    merged.set(binding.markerKey, [...(merged.get(binding.markerKey) ?? []), binding]);
  }
  return merged;
}

// 织入分析入口：挂在 analyzeWebRoutes 之后（provider 全集在手）、createExecutionPlans 之前
// （追加边直接参与构造排序 / cycle-proxy 改写 / request 计划）。拦截器被强制为 singleton，
// 追加边因此不触 validateScopeRules 的任何规则（singleton/request → singleton 恒合法）。
export function analyzeMethodInterception(
  sources: readonly ParsedSource[],
  linker: ProjectLinker,
  providers: readonly ProviderModel[],
  diagnostics: CompilerDiagnostic[],
  // contribute 相位贡献的框架绑定（#344 定案 2）。此前这里是一句跨文件硬编码——直接
  // `providerById.has(transactionInterceptorBeanId)` 再就地拼一条事务绑定，也就是 transaction
  // 域向本文件的一次隐式贡献。现在贡献方自己声明写 interceptorBindings 通道，本文件只消费。
  contributed: readonly InterceptorBinding[] = [],
): WeavingModel {
  const markers = collectMethodMarkers(sources, linker, diagnostics);
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const bindings = mergeContributedBindings(
    collectInterceptorBindings(sources, linker, markers, providerById, diagnostics),
    contributed,
    providerById,
  );
  const scans = scanMarkedClasses(sources, linker, markers, diagnostics);
  reportOverrideDroppedMarkers(sources, linker, scans, providerById, diagnostics);

  const beans: WovenBeanModel[] = [];
  for (const scan of scans) {
    const provider = claimWovenBean(scan.source, scan.declaration, providerById, diagnostics);
    if (provider === undefined || !scan.valid) {
      continue;
    }
    const className = scan.declaration.name ?? "an anonymous class";
    const methods: { readonly name: string; readonly scan: MarkedMethodScan }[] = [];
    let valid = true;
    for (const marked of scan.methods) {
      const name = validWovenMethod(marked.method, className, diagnostics);
      if (name === undefined) {
        valid = false;
        continue;
      }
      methods.push({ name, scan: marked });
    }
    if (!valid) {
      continue;
    }
    beans.push(wovenBeanModelOf({ scan, provider, methods }, bindings));
  }
  return {
    beans: Object.freeze(
      beans.toSorted((left, right) => compareUtf16CodeUnits(left.beanId, right.beanId)),
    ),
  };
}
