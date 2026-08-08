import { compareUtf16CodeUnits } from "@reforce/primitives";
import {
  type BeanRole,
  beanRoleOfDecorator,
  beanRoleSpecOf,
  reportRoleRequestScope,
  soleBeanRoleOf,
} from "@/analysis/bean-roles";
import {
  type PendingDependency,
  type ProviderDraft,
  providerId,
  type QualifierModel,
  reportUnsupportedType,
  sourceReference,
} from "@/analysis/model";
import { transactionManagerContractsOf } from "@/analysis/transaction-weaving";
import type { CompilerDiagnostic } from "@/api";
import { diagnostic } from "@/diagnostics";
import type { LinkedSymbol, LinkedType } from "@/linking/model";
import type { ProjectLinker } from "@/linking/project-linker";
import type {
  ClassDeclaration,
  ClassMethodDeclaration,
  DecoratorUse,
  TypeNode,
} from "@/parser/source-ir";
import type { SourceSpan } from "@/parser/source-location";
import type { ParsedSource } from "@/project/source-files";

function isEntityDecorator(decorator: DecoratorUse): decorator is DecoratorUse & {
  readonly callee: Exclude<DecoratorUse["callee"], { readonly kind: "unsupported-expression" }>;
} {
  return decorator.callee.kind !== "unsupported-expression";
}

function coreDecorators(
  source: ParsedSource,
  decorators: readonly DecoratorUse[],
  linker: ProjectLinker,
): ReadonlyMap<string, readonly DecoratorUse[]> {
  const result = new Map<string, DecoratorUse[]>();
  for (const decorator of decorators) {
    if (!isEntityDecorator(decorator)) {
      continue;
    }
    const symbol = linker.resolveEntity(source, decorator.callee);
    if (symbol?.kind !== "core") {
      continue;
    }
    const existing = result.get(symbol.name) ?? [];
    existing.push(decorator);
    result.set(symbol.name, existing);
  }
  return result;
}

// 角色装饰器扫描（bean-roles.ts）：context 与 web 两个框架面的角色装饰器走同一次解析，
// 因为它们对 bean 身份的作用完全一致。
function beanRolesOf(
  source: ParsedSource,
  decorators: readonly DecoratorUse[],
  linker: ProjectLinker,
): ReadonlySet<BeanRole> {
  const roles = new Set<BeanRole>();
  for (const decorator of decorators) {
    if (!isEntityDecorator(decorator)) {
      continue;
    }
    const role = beanRoleOfDecorator(linker.resolveEntity(source, decorator.callee));
    if (role !== undefined) {
      roles.add(role);
    }
  }
  return roles;
}

function stringDecoratorArgument(decorator: DecoratorUse): string | undefined {
  const argument = decorator.arguments.at(0);
  return argument?.kind === "string-literal" && decorator.arguments.length === 1
    ? argument.value
    : undefined;
}

function methodName(method: ClassMethodDeclaration): string | undefined {
  if (method.name.kind === "identifier") {
    return method.name.name;
  }
  return method.name.kind === "string-literal" ? method.name.value : undefined;
}

function isVoidType(type: TypeNode | undefined): boolean {
  return type?.kind === "primitive" && type.name === "void";
}

function isPromiseVoidType(type: TypeNode | undefined): boolean {
  if (
    type?.kind !== "reference" ||
    type.name.kind !== "identifier" ||
    type.name.name !== "Promise" ||
    type.typeArguments.length !== 1
  ) {
    return false;
  }
  return isVoidType(type.typeArguments[0]);
}

function validLifecycleReturn(method: ClassMethodDeclaration): boolean {
  return method.async
    ? isPromiseVoidType(method.returnType)
    : isVoidType(method.returnType) || isPromiseVoidType(method.returnType);
}

function validLifecycleMethod(methods: readonly ClassMethodDeclaration[], name: string): boolean {
  const ambiguousComputedCandidate = methods.some(
    (method) =>
      method.name.kind === "computed" &&
      method.static === false &&
      method.accessibility === "public" &&
      method.generator === false &&
      method.optional === false &&
      method.implementation === true &&
      method.parameters.length === 0 &&
      validLifecycleReturn(method),
  );
  if (ambiguousComputedCandidate) {
    return false;
  }
  const candidates = methods.filter((method) => methodName(method) === name);
  const candidate = candidates.length === 1 ? candidates[0] : undefined;
  return (
    candidate?.static === false &&
    candidate.accessibility === "public" &&
    candidate.generator === false &&
    candidate.optional === false &&
    candidate.implementation === true &&
    candidate.parameters.length === 0 &&
    validLifecycleReturn(candidate)
  );
}

// config-provider 复用：config class 的 provides 同样由自身符号 + implements 契约构成。
export function dedupeSymbols(symbols: readonly LinkedSymbol[]): readonly LinkedSymbol[] {
  const byKey = new Map<string, LinkedSymbol>();
  for (const symbol of symbols) {
    byKey.set(symbol.key, symbol);
  }
  return [...byKey.values()].sort((left, right) => compareUtf16CodeUnits(left.key, right.key));
}

function expandProvidedInterface(
  symbol: LinkedSymbol,
  linker: ProjectLinker,
  diagnostics: CompilerDiagnostic[],
  visited = new Set<string>(),
): readonly LinkedSymbol[] {
  if (visited.has(symbol.key)) {
    return [];
  }
  visited.add(symbol.key);
  const source = symbol.source;
  if (symbol.kind !== "interface") {
    return [];
  }
  if (source === undefined) {
    return [symbol];
  }
  if (symbol.declaration?.kind !== "interface") {
    return [];
  }
  const parents = symbol.declaration.extends.flatMap((type) => {
    // linker.resolveType already records its own diagnostic when it fails; only add
    // TYPE_LINK_FAILED when it didn't, or the same parent type gets reported twice (#108).
    const diagnosticCount = linker.diagnostics.length;
    const linked = linker.resolveType(source, type);
    if (linked === undefined) {
      if (linker.diagnostics.length === diagnosticCount) {
        diagnostics.push(
          diagnostic({
            code: "TYPE_LINK_FAILED",
            message: `Cannot link a parent interface of ${symbol.name}.`,
            sourceSpan: type.span,
            help: "Extend only directly linked non-generic application interfaces.",
          }),
        );
      }
      return [];
    }
    if (linked.symbol.kind === "unsupported") {
      reportUnsupportedType(diagnostics, linked.symbol, type.span);
      return [];
    }
    if (linked.symbol.generic || linked.typeArguments.length > 0) {
      diagnostics.push(
        diagnostic({
          code: "UNSUPPORTED_GENERIC_INTERFACE",
          message: `Parent interface ${linked.symbol.name} cannot use generic arguments.`,
          sourceSpan: type.span,
          help: "Extend a non-generic application interface.",
        }),
      );
      return [];
    }
    if (
      linked.symbol.kind !== "interface" ||
      linked.symbol.source === undefined ||
      linked.symbol.declaration?.kind !== "interface"
    ) {
      diagnostics.push(
        diagnostic({
          code: "TYPE_LINK_FAILED",
          message: `Parent ${linked.symbol.name} is not an application interface.`,
          sourceSpan: type.span,
          help: "Extend only directly linked non-generic application interfaces.",
        }),
      );
      return [];
    }
    return expandProvidedInterface(linked.symbol, linker, diagnostics, visited);
  });
  return [symbol, ...parents];
}

function addInvalidDecoratorDiagnostic(
  diagnostics: CompilerDiagnostic[],
  message: string,
  span: SourceSpan,
): void {
  diagnostics.push(
    diagnostic({
      code: "INVALID_DECORATOR_USAGE",
      message,
      sourceSpan: span,
      help: "Use each Reforce decorator once with its documented literal arguments.",
    }),
  );
}

interface ClassDecoratorSelection {
  readonly primary: boolean;
  readonly fallback: boolean;
  readonly eager: boolean;
  readonly requestScoped: boolean;
  readonly qualifierDecorators: readonly DecoratorUse[];
  readonly explicitQualifier?: string | undefined;
  readonly order?: number | undefined;
  readonly role?: BeanRole | undefined;
}

function validateMarkerDecorators(
  name: string,
  decorators: readonly DecoratorUse[],
  declaration: ClassDeclaration,
  diagnostics: CompilerDiagnostic[],
): void {
  const invalid =
    decorators.length > 1 ||
    decorators.some((decorator) => !decorator.called || decorator.arguments.length !== 0);
  if (!invalid) {
    return;
  }
  addInvalidDecoratorDiagnostic(
    diagnostics,
    `${name} must appear at most once as @${name}().`,
    decorators[0]?.span ?? declaration.span,
  );
}

function explicitQualifierFrom(
  decorators: readonly DecoratorUse[],
  diagnostics: CompilerDiagnostic[],
): string | undefined {
  const first = decorators.at(0);
  if (first === undefined) {
    return undefined;
  }
  const value = stringDecoratorArgument(first);
  if (decorators.length !== 1 || !first.called || value === undefined) {
    addInvalidDecoratorDiagnostic(
      diagnostics,
      "Qualifier must appear at most once with one string literal.",
      first.span,
    );
  }
  return value;
}

function orderFrom(
  decorators: readonly DecoratorUse[],
  diagnostics: CompilerDiagnostic[],
): number | undefined {
  const first = decorators.at(0);
  if (first === undefined) {
    return undefined;
  }
  const argument = first.arguments.at(0);
  const value =
    argument?.kind === "number-literal" && first.arguments.length === 1
      ? argument.value
      : undefined;
  if (decorators.length !== 1 || !first.called || value === undefined || !Number.isInteger(value)) {
    addInvalidDecoratorDiagnostic(
      diagnostics,
      "Order must appear at most once as @Order(n) with one integer literal.",
      first.span,
    );
    return undefined;
  }
  return value;
}

// bean 身份判定：角色装饰器与 @Injectable() 是两条互斥的声明入口（bean-roles.ts）。
// markerDecorators 只在"两条入口都没走"时用来点名——Primary/RequestScoped/Qualifier/Order
// 本身不构成身份。
function declaresBean(
  role: BeanRole | undefined,
  injectable: readonly DecoratorUse[],
  markerDecorators: readonly DecoratorUse[],
  declaration: ClassDeclaration,
  diagnostics: CompilerDiagnostic[],
): boolean {
  if (role !== undefined) {
    if (injectable.length === 0) {
      return true;
    }
    // 角色装饰器已经蕴含 bean 身份：并列的 @Injectable() 携带零比特信息。允许两种写法等于
    // 两种风格，评审时永远要争，所以原位拒绝而不是"允许但不必填"。
    addInvalidDecoratorDiagnostic(
      diagnostics,
      `${beanRoleSpecOf(role).decorator} already declares this class a Bean; remove Injectable.`,
      injectable[0]?.span ?? declaration.span,
    );
    return false;
  }
  if (injectable.length === 0) {
    for (const decorator of markerDecorators) {
      addInvalidDecoratorDiagnostic(
        diagnostics,
        "Primary, Fallback, RequestScoped, Qualifier, and Order can only mark a Bean class.",
        decorator.span,
      );
    }
    return false;
  }
  if (
    injectable.length !== 1 ||
    injectable[0]?.called !== true ||
    injectable[0]?.arguments.length !== 0
  ) {
    addInvalidDecoratorDiagnostic(
      diagnostics,
      "Injectable must appear exactly once as @Injectable().",
      injectable[0]?.span ?? declaration.span,
    );
    return false;
  }
  return true;
}

function classDecoratorSelection(
  source: ParsedSource,
  declaration: ClassDeclaration,
  linker: ProjectLinker,
  diagnostics: CompilerDiagnostic[],
): ClassDecoratorSelection | undefined {
  const decorators = coreDecorators(source, declaration.decorators, linker);
  const injectable = decorators.get("Injectable") ?? [];
  const primaryDecorators = decorators.get("Primary") ?? [];
  const fallbackDecorators = decorators.get("Fallback") ?? [];
  const eagerDecorators = decorators.get("Eager") ?? [];
  const requestScopedDecorators = decorators.get("RequestScoped") ?? [];
  const qualifierDecorators = decorators.get("Qualifier") ?? [];
  const orderDecorators = decorators.get("Order") ?? [];
  const role = soleBeanRoleOf(beanRolesOf(source, declaration.decorators, linker));
  const declared = declaresBean(
    role,
    injectable,
    [
      ...primaryDecorators,
      ...fallbackDecorators,
      ...eagerDecorators,
      ...requestScopedDecorators,
      ...qualifierDecorators,
      ...orderDecorators,
    ],
    declaration,
    diagnostics,
  );
  if (!declared) {
    return undefined;
  }
  validateMarkerDecorators("Primary", primaryDecorators, declaration, diagnostics);
  validateMarkerDecorators("Fallback", fallbackDecorators, declaration, diagnostics);
  validateMarkerDecorators("Eager", eagerDecorators, declaration, diagnostics);
  validateMarkerDecorators("RequestScoped", requestScopedDecorators, declaration, diagnostics);
  const requestScoped = requestScopedDecorators.length >= 1;
  // 角色 bean 恒为 singleton（bean-roles.ts）：框架在启动期一次性解析它们，请求态经
  // RequestContext / Current<T> 流动。
  if (role !== undefined && requestScoped) {
    reportRoleRequestScope(
      role,
      declaration.name ?? "An anonymous class",
      declaration.span,
      diagnostics,
    );
    return undefined;
  }
  // @Order 只服务集合成员排序，而请求作用域 bean 不能入集合（ADR 0006 W7 交叉形态从紧），
  // 两个标记同时出现只能是误解，原位拒绝。
  const orderOnRequestScoped = requestScoped ? orderDecorators.at(0) : undefined;
  if (orderOnRequestScoped !== undefined) {
    addInvalidDecoratorDiagnostic(
      diagnostics,
      "Order cannot mark a request-scoped class: request Beans never join collections.",
      orderOnRequestScoped.span,
    );
    return undefined;
  }
  const explicitQualifier = explicitQualifierFrom(qualifierDecorators, diagnostics);
  const order = orderFrom(orderDecorators, diagnostics);
  return {
    primary: primaryDecorators.length === 1,
    fallback: fallbackDecorators.length === 1,
    eager: eagerDecorators.length === 1,
    requestScoped,
    qualifierDecorators,
    explicitQualifier,
    ...(order === undefined ? {} : { order }),
    ...(role === undefined ? {} : { role }),
  };
}

function exportedInjectableName(
  declaration: ClassDeclaration,
  diagnostics: CompilerDiagnostic[],
): string | undefined {
  const exportName = declaration.name;
  if (
    declaration.topLevel &&
    !declaration.abstract &&
    exportName !== undefined &&
    declaration.export.kind === "named" &&
    !declaration.generic
  ) {
    return exportName;
  }
  diagnostics.push(
    diagnostic({
      code: "INVALID_INJECTABLE",
      message: "A Bean must be a top-level, non-abstract, non-generic direct named export.",
      sourceSpan: declaration.span,
      help: "Export a named concrete class directly from its defining module.",
    }),
  );
  return undefined;
}

interface ImplementationConstructorSelection {
  readonly valid: boolean;
  // 声明该构造器的模块：参数类型必须在这个模块的作用域里解析，继承来的构造器与 Injectable
  // 不在同一文件时二者不同。
  readonly source?: ParsedSource;
  readonly declaration?: ClassDeclaration["constructors"][number];
  // 依赖边的位置改锚到 Injectable 自己的声明位：构造器来自 node_modules 的 .d.ts 时，参数 span
  // 的 fileId 是外部闭包的合成 id（external/<digest>.ts），渲染器按应用根 join 读不到文件，只
  // 剩一行毫无意义的路径。"依赖未满足"是继承自 starter 基类时最常见的失败，它必须指回用户
  // 自己的类。参数形态本身的诊断没有一并改锚：那些位置有一半出自 linker.resolveType 内部，
  // 从这里够不着——而 starter 的构造器参数已经在它自己的 `reforce lib` 里验过一遍。
  readonly dependencySpanOverride?: SourceSpan;
}

// 同一个类自己写下的构造器（不含继承）。.d.ts 里的构造器一律没有函数体，所以"实现构造器"
// 这条判据只对源码模块成立；环境声明模块改判"至多一条签名"，多条即重载、同样不可判定。
function ownConstructorOf(
  source: ParsedSource,
  declaration: ClassDeclaration,
): { readonly valid: boolean; readonly declaration?: ClassDeclaration["constructors"][number] } {
  const ambient = source.sourceKind.startsWith("d.");
  const candidates = ambient
    ? declaration.constructors
    : declaration.constructors.filter((candidate) => candidate.implementation);
  const overloaded = ambient
    ? false
    : declaration.constructors.some((candidate) => !candidate.implementation);
  if (overloaded || candidates.length > 1) {
    return { valid: false };
  }
  const selected = candidates.at(0);
  return selected === undefined ? { valid: true } : { valid: true, declaration: selected };
}

// 语法继承链限深：与 web-slots 的 aliasFollowLimit、web-routes 的 heritageFollowLimit 同一
// 预算——循环 extends 无稳定去重身份，只能靠预算兜住。
const heritageFollowLimit = 16;

interface HeritageClass {
  readonly source: ParsedSource;
  readonly declaration: ClassDeclaration;
  // 基类在应用源码集内声明时为真：诊断可以照常锚在基类自己的位置上，那是用户能打开的文件。
  readonly withinApplication: boolean;
}

function heritageClassOf(
  source: ParsedSource,
  declaration: ClassDeclaration,
  linker: ProjectLinker,
): HeritageClass | undefined {
  const heritage = declaration.heritage;
  // extends f(...)（mixin）与任意表达式形态跟不出静态类身份，继承链在此断开：此时依赖表
  // 保持为空，与本次修复前同解——真正兜住它的是生成物进类型检查那一层。
  if (heritage?.kind !== "reference") {
    return undefined;
  }
  const symbol = linker.resolveEntity(source, heritage.entity);
  if (symbol?.declaration?.kind !== "class" || symbol.declaringSource === undefined) {
    return undefined;
  }
  return {
    source: symbol.declaringSource,
    declaration: symbol.declaration,
    withinApplication: symbol.source !== undefined,
  };
}

// 派生类不写构造器时，TypeScript 补的是 `constructor(...args) { super(...args) }`——实参照原样
// 转发给最近一个自己写了构造器的祖先。依赖边必须按那个祖先的参数表建，否则生成物 emit
// `new Foo()`，基类字段被静默赋 undefined，直到首次访问才 TypeError（#350）。
function implementationConstructorFor(
  source: ParsedSource,
  declaration: ClassDeclaration,
  linker: ProjectLinker,
  diagnostics: CompilerDiagnostic[],
): ImplementationConstructorSelection {
  const invalid = (message: string, help: string): ImplementationConstructorSelection => {
    diagnostics.push(
      diagnostic({ code: "INVALID_INJECTABLE", message, sourceSpan: declaration.span, help }),
    );
    return { valid: false };
  };
  const shapeHelp = "Remove constructor overloads and expose one public constructor.";
  const shapeMessage =
    "An Injectable must have zero or one public implementation constructor and no overload signatures.";
  let current: HeritageClass = { source, declaration, withinApplication: true };
  for (let depth = 0; depth <= heritageFollowLimit; depth += 1) {
    const own = ownConstructorOf(current.source, current.declaration);
    if (!own.valid) {
      return invalid(shapeMessage, shapeHelp);
    }
    if (own.declaration !== undefined) {
      // 可见性只对类自己的构造器成立：生成物 `new Foo()` 直接调用它。祖先的 protected 构造器
      // 由派生类隐式构造器经 super() 调用，照样可实例化；祖先的 private 构造器在 TypeScript
      // 里根本 extends 不了，到不了这里。
      if (depth === 0 && ["private", "protected"].includes(own.declaration.accessibility)) {
        return invalid(shapeMessage, shapeHelp);
      }
      return {
        valid: true,
        source: current.source,
        declaration: own.declaration,
        ...(current.withinApplication ? {} : { dependencySpanOverride: declaration.span }),
      };
    }
    const next = heritageClassOf(current.source, current.declaration, linker);
    if (next === undefined) {
      return { valid: true };
    }
    current = next;
  }
  return invalid(
    `Cannot determine the constructor of ${declaration.name ?? "an Injectable"}: its extends chain is circular or deeper than ${heritageFollowLimit}.`,
    "Break the extends cycle or flatten the base class chain.",
  );
}

interface LinkedClassContracts {
  readonly provided: readonly LinkedSymbol[];
  readonly startHook: boolean;
  readonly closeHook: boolean;
}

function linkedImplementedType(
  source: ParsedSource,
  implementedType: TypeNode,
  exportName: string,
  linker: ProjectLinker,
  diagnostics: CompilerDiagnostic[],
): LinkedType | undefined {
  // linker.resolveType already records its own diagnostic when it fails; only add
  // TYPE_LINK_FAILED when it didn't, or the same implemented type gets reported twice (#108).
  const diagnosticCount = linker.diagnostics.length;
  const linked = linker.resolveType(source, implementedType);
  if (linked === undefined && linker.diagnostics.length === diagnosticCount) {
    diagnostics.push(
      diagnostic({
        code: "TYPE_LINK_FAILED",
        message: `Cannot link an implemented interface on ${exportName}.`,
        sourceSpan: implementedType.span,
        help: "Implement a directly linked non-generic named interface.",
      }),
    );
  }
  return linked;
}

// config-provider 复用：同一套 implements 契约链接与 lifecycle 接口探测。
export function linkedClassContracts(
  source: ParsedSource,
  declaration: ClassDeclaration,
  exportName: string,
  ownSymbol: LinkedSymbol,
  linker: ProjectLinker,
  diagnostics: CompilerDiagnostic[],
): LinkedClassContracts {
  const provided: LinkedSymbol[] = [ownSymbol];
  let startHook = false;
  let closeHook = false;
  for (const implementedType of declaration.implements) {
    const linked = linkedImplementedType(source, implementedType, exportName, linker, diagnostics);
    if (linked === undefined) {
      continue;
    }
    if (linked.symbol.kind === "core") {
      startHook ||= linked.symbol.name === "OnContextStart";
      closeHook ||= linked.symbol.name === "OnContextClose";
      // 其余 context 符号不是契约，保持沉默跳过。
      continue;
    }
    if (linked.symbol.kind === "transaction") {
      // TransactionManager 是框架拥有的注入契约（ADR 0008 T4，#204 定案 3；WebEngineAdapter
      // 同族先例）：implements 的类型实参（TransactionManager<R>）在契约身份上擦除，
      // 注入边按合成符号 key 解析。其余 transaction 符号不是契约，保持沉默跳过。
      provided.push(...transactionManagerContractsOf(linked.symbol));
      continue;
    }
    if (linked.symbol.kind === "unsupported") {
      reportUnsupportedType(diagnostics, linked.symbol, implementedType.span);
      continue;
    }
    if (linked.symbol.kind !== "interface") {
      continue;
    }
    if (linked.symbol.generic || linked.typeArguments.length > 0) {
      diagnostics.push(
        diagnostic({
          code: "UNSUPPORTED_GENERIC_INTERFACE",
          message: `Interface ${linked.symbol.name} cannot use generic arguments as an Injectable contract.`,
          sourceSpan: implementedType.span,
          help: "Introduce a non-generic application interface for dependency injection.",
        }),
      );
      continue;
    }
    provided.push(...expandProvidedInterface(linked.symbol, linker, diagnostics));
  }
  return { provided, startHook, closeHook };
}

function validateLifecycleMethods(
  declaration: ClassDeclaration,
  exportName: string,
  contracts: LinkedClassContracts,
  diagnostics: CompilerDiagnostic[],
): void {
  const invalidStart =
    contracts.startHook && !validLifecycleMethod(declaration.methods, "onContextStart");
  const invalidClose =
    contracts.closeHook && !validLifecycleMethod(declaration.methods, "onContextClose");
  if (!invalidStart && !invalidClose) {
    return;
  }
  diagnostics.push(
    diagnostic({
      code: "INVALID_LIFECYCLE_DECLARATION",
      message: `Lifecycle methods on ${exportName} must be unique public instance implementations with zero parameters and return void or Promise<void>.`,
      sourceSpan: declaration.span,
      help: "Implement the declared lifecycle interface with one compatible method.",
    }),
  );
}

interface CollectionSyntax {
  readonly element: TypeNode;
  readonly readonlyModifier: boolean;
}

// 集合边的两种书写（ADR 0006 W6，#142）：readonly T[] 与全局 ReadonlyArray<T>。可变形态（T[]、
// Array<T>）也要在这里识别，才能给出"改成 readonly"的指引而不是泛化的注入类型错误。全局名
// 仅在未被应用符号遮蔽时按集合语法解释。
function collectionSyntaxOf(
  source: ParsedSource,
  type: TypeNode,
  linker: ProjectLinker,
): CollectionSyntax | undefined {
  if (type.kind === "array") {
    return { element: type.element, readonlyModifier: type.readonlyModifier };
  }
  if (
    type.kind !== "reference" ||
    type.name.kind !== "identifier" ||
    (type.name.name !== "Array" && type.name.name !== "ReadonlyArray") ||
    type.typeArguments.length !== 1 ||
    linker.resolveEntity(source, type.name) !== undefined
  ) {
    return undefined;
  }
  const element = type.typeArguments[0];
  if (element === undefined) {
    return undefined;
  }
  return { element, readonlyModifier: type.name.name === "ReadonlyArray" };
}

function collectionDiagnostic(
  diagnostics: CompilerDiagnostic[],
  message: string,
  span: SourceSpan,
  help: string,
): void {
  diagnostics.push(
    diagnostic({ code: "INVALID_COLLECTION_INJECTION", message, sourceSpan: span, help }),
  );
}

const collectionElementHelp =
  "Use readonly T[] where T is one linked non-generic class or interface contract.";

function collectionElementShapeError(
  source: ParsedSource,
  syntax: CollectionSyntax,
  linker: ProjectLinker,
): string | undefined {
  if (collectionSyntaxOf(source, syntax.element, linker) !== undefined) {
    return "nests a collection inside a collection, which is not supported yet";
  }
  if (syntax.element.kind !== "reference") {
    return "has a collection element that is not a supported contract";
  }
  return undefined;
}

function linkedCollectionElementError(linked: LinkedType): string | undefined {
  if (linked.lazy) {
    return "combines a collection with a Lazy element, which is not supported yet";
  }
  if (linked.current) {
    return "combines a collection with a Current element, which is not supported yet";
  }
  if (linked.qualifierMember !== undefined) {
    return "combines a collection with a qualified member element, which is not supported yet";
  }
  const linkableContract = linked.symbol.kind === "class" || linked.symbol.kind === "interface";
  if (!linkableContract || linked.symbol.generic || linked.typeArguments.length > 0) {
    return "has a collection element that is not a non-generic class or interface contract";
  }
  return undefined;
}

function collectionElementType(
  source: ParsedSource,
  parameter: ClassDeclaration["constructors"][number]["parameters"][number],
  syntax: CollectionSyntax,
  exportName: string,
  linker: ProjectLinker,
  diagnostics: CompilerDiagnostic[],
): LinkedType | undefined {
  const location = `Constructor parameter ${parameter.index} on ${exportName}`;
  const shapeError = collectionElementShapeError(source, syntax, linker);
  if (shapeError !== undefined) {
    collectionDiagnostic(
      diagnostics,
      `${location} ${shapeError}.`,
      parameter.span,
      collectionElementHelp,
    );
    return undefined;
  }
  // linker.resolveType already records its own diagnostic when it fails; only add
  // INVALID_COLLECTION_INJECTION when it didn't, or one bad element type is reported twice (#108).
  const diagnosticCount = linker.diagnostics.length;
  const linked = linker.resolveType(source, syntax.element);
  if (linked === undefined) {
    if (linker.diagnostics.length === diagnosticCount) {
      collectionDiagnostic(
        diagnostics,
        `${location} has a collection element that is not a supported contract.`,
        parameter.span,
        collectionElementHelp,
      );
    }
    return undefined;
  }
  if (linked.symbol.kind === "unsupported") {
    reportUnsupportedType(diagnostics, linked.symbol, syntax.element.span);
    return undefined;
  }
  const linkError = linkedCollectionElementError(linked);
  if (linkError !== undefined) {
    collectionDiagnostic(
      diagnostics,
      `${location} ${linkError}.`,
      parameter.span,
      collectionElementHelp,
    );
    return undefined;
  }
  return linked;
}

function collectionParameterDependency(
  source: ParsedSource,
  parameter: ClassDeclaration["constructors"][number]["parameters"][number],
  syntax: CollectionSyntax,
  exportName: string,
  linker: ProjectLinker,
  diagnostics: CompilerDiagnostic[],
): PendingDependency | undefined {
  if (!syntax.readonlyModifier) {
    collectionDiagnostic(
      diagnostics,
      `Constructor parameter ${parameter.index} on ${exportName} injects a mutable array.`,
      parameter.span,
      "Declare the collection as readonly T[]: injected collections are read-only.",
    );
    return undefined;
  }
  const linked = collectionElementType(source, parameter, syntax, exportName, linker, diagnostics);
  if (linked === undefined) {
    return undefined;
  }
  return {
    index: parameter.index,
    linkedType: linked,
    collection: true,
    sourceSpan: parameter.span,
  };
}

// Lazy<readonly T[]> 一类"泛型包集合"的形态：链接层解不出类型也不报错（Lazy 匹配但内层不是
// 引用），这里点名集合组合形态，不让它退化成泛化的注入类型错误。
function referencesCollectionArgument(
  source: ParsedSource,
  type: TypeNode,
  linker: ProjectLinker,
): boolean {
  return (
    type.kind === "reference" &&
    type.typeArguments.some(
      (argument) => collectionSyntaxOf(source, argument, linker) !== undefined,
    )
  );
}

function reportUnresolvedParameterType(
  source: ParsedSource,
  parameter: ClassDeclaration["constructors"][number]["parameters"][number],
  exportName: string,
  linker: ProjectLinker,
  diagnostics: CompilerDiagnostic[],
): void {
  if (referencesCollectionArgument(source, parameter.type, linker)) {
    collectionDiagnostic(
      diagnostics,
      `Constructor parameter ${parameter.index} on ${exportName} wraps a collection in a generic, which is not supported yet.`,
      parameter.span,
      "Inject the collection directly as readonly T[].",
    );
    return;
  }
  diagnostics.push(
    diagnostic({
      code: "UNSUPPORTED_INJECTION_TYPE",
      message: `Constructor parameter ${parameter.index} on ${exportName} is not a supported injection type.`,
      sourceSpan: parameter.span,
      help: "Use a named concrete class, interface, generated qualifier, or Lazy wrapper.",
    }),
  );
}

// context 符号不是契约：ApplicationContext 禁注入；Lazy<Current<T>> / Current<Lazy<T>> /
// Current<Current<T>> 句柄套句柄（ADR 0006 W7 交叉形态从紧）点名拒绝，不落进泛化注入类型错误。
function reportCoreSymbolMisuse(
  linked: LinkedType,
  parameter: ClassDeclaration["constructors"][number]["parameters"][number],
  exportName: string,
  diagnostics: CompilerDiagnostic[],
): boolean {
  if (linked.symbol.kind !== "core") {
    return false;
  }
  if (linked.symbol.name === "ApplicationContext") {
    diagnostics.push(
      diagnostic({
        code: "UNSUPPORTED_APPLICATION_CONTEXT_INJECTION",
        message: "ApplicationContext cannot be injected into a constructor.",
        sourceSpan: parameter.span,
        help: "Move coordination outside the Bean constructor.",
      }),
    );
    return true;
  }
  const handleSymbol = linked.symbol.name === "Lazy" || linked.symbol.name === "Current";
  const nestedHandle =
    handleSymbol && (linked.current || (linked.lazy && linked.symbol.name === "Current"));
  if (nestedHandle) {
    diagnostics.push(
      diagnostic({
        code: "INVALID_CURRENT_INJECTION",
        message: `Constructor parameter ${parameter.index} on ${exportName} nests dependency handles, which is not supported.`,
        sourceSpan: parameter.span,
        help: "Use a single Current<T> or Lazy<T> wrapper around the contract.",
      }),
    );
    return true;
  }
  return false;
}

function constructorParameterDependency(
  source: ParsedSource,
  parameter: ClassDeclaration["constructors"][number]["parameters"][number],
  exportName: string,
  linker: ProjectLinker,
  diagnostics: CompilerDiagnostic[],
): PendingDependency | undefined {
  if (
    parameter.optional ||
    parameter.rest ||
    parameter.hasInitializer ||
    parameter.decorators.length > 0
  ) {
    diagnostics.push(
      diagnostic({
        code:
          parameter.decorators.length > 0
            ? "INVALID_DECORATOR_USAGE"
            : "UNSUPPORTED_INJECTION_TYPE",
        message: `Constructor parameter ${parameter.index} on ${exportName} uses an unsupported shape.`,
        sourceSpan: parameter.span,
        help: "Use a required parameter with a named class, interface, qualifier, or Lazy type.",
      }),
    );
    return undefined;
  }
  const collectionSyntax = collectionSyntaxOf(source, parameter.type, linker);
  if (collectionSyntax !== undefined) {
    return collectionParameterDependency(
      source,
      parameter,
      collectionSyntax,
      exportName,
      linker,
      diagnostics,
    );
  }
  // linker.resolveType already records its own diagnostic when it fails; only add
  // UNSUPPORTED_INJECTION_TYPE when it didn't, or one bad parameter type is reported twice (#108).
  const diagnosticCount = linker.diagnostics.length;
  const linked = linker.resolveType(source, parameter.type);
  if (linked === undefined) {
    if (linker.diagnostics.length === diagnosticCount) {
      reportUnresolvedParameterType(source, parameter, exportName, linker, diagnostics);
    }
    return undefined;
  }
  if (reportCoreSymbolMisuse(linked, parameter, exportName, diagnostics)) {
    return undefined;
  }
  if (linked.symbol.kind === "unsupported") {
    reportUnsupportedType(diagnostics, linked.symbol, parameter.type.span);
    return undefined;
  }
  if (
    linked.symbol.kind === "interface" &&
    (linked.symbol.generic || linked.typeArguments.length > 0)
  ) {
    diagnostics.push(
      diagnostic({
        code: "UNSUPPORTED_GENERIC_INTERFACE",
        message: `Generic dependency ${linked.symbol.name} is not supported.`,
        sourceSpan: parameter.span,
        help: "Inject a non-generic application interface.",
      }),
    );
    return undefined;
  }
  if (linked.typeArguments.length > 0) {
    diagnostics.push(
      diagnostic({
        code: "UNSUPPORTED_INJECTION_TYPE",
        message: `Generic dependency ${linked.symbol.name} is not supported.`,
        sourceSpan: parameter.span,
        help: "Inject a non-generic concrete class or application interface.",
      }),
    );
    return undefined;
  }
  return { index: parameter.index, linkedType: linked, sourceSpan: parameter.span };
}

// 构造器可能继承自基类，所以参数类型按 selection.source（声明该构造器的模块）解析，而不是
// 按 Injectable 所在的模块——两者不同文件时，基类 import 进来的契约只在基类模块的作用域里
// 有名字（#350）。
function constructorDependencies(
  selection: ImplementationConstructorSelection,
  fallbackSource: ParsedSource,
  exportName: string,
  linker: ProjectLinker,
  diagnostics: CompilerDiagnostic[],
): readonly PendingDependency[] {
  const source = selection.source ?? fallbackSource;
  return (selection.declaration?.parameters ?? []).flatMap((parameter) => {
    const dependency = constructorParameterDependency(
      source,
      parameter,
      exportName,
      linker,
      diagnostics,
    );
    if (dependency === undefined) {
      return [];
    }
    return [
      selection.dependencySpanOverride === undefined
        ? dependency
        : { ...dependency, sourceSpan: selection.dependencySpanOverride },
    ];
  });
}

function classQualifiers(
  provides: readonly LinkedSymbol[],
  exportName: string,
  selection: ClassDecoratorSelection,
  declaration: ClassDeclaration,
  diagnostics: CompilerDiagnostic[],
): readonly QualifierModel[] {
  const eligibleInterfaces = provides.filter(
    (symbol) =>
      symbol.kind === "interface" &&
      symbol.source !== undefined &&
      symbol.declaration?.kind === "interface" &&
      symbol.declaration.export.kind === "named" &&
      !symbol.generic,
  );
  if (selection.explicitQualifier !== undefined && eligibleInterfaces.length === 0) {
    diagnostics.push(
      diagnostic({
        code: "INVALID_BEAN_QUALIFIER",
        message: `Qualifier on ${exportName} has no eligible application interface.`,
        sourceSpan: selection.qualifierDecorators[0]?.span ?? declaration.span,
        help: "Implement an exported non-generic application interface or remove Qualifier.",
      }),
    );
  }
  const member = selection.explicitQualifier ?? exportName;
  return eligibleInterfaces.map((interfaceSymbol) => ({ interfaceSymbol, member }));
}

export function analyzeClassProvider(
  source: ParsedSource,
  declaration: ClassDeclaration,
  linker: ProjectLinker,
  diagnostics: CompilerDiagnostic[],
): ProviderDraft | undefined {
  const selection = classDecoratorSelection(source, declaration, linker, diagnostics);
  if (selection === undefined) {
    return undefined;
  }
  const exportName = exportedInjectableName(declaration, diagnostics);
  if (exportName === undefined) {
    return undefined;
  }
  const implementation = implementationConstructorFor(source, declaration, linker, diagnostics);
  if (!implementation.valid) {
    return undefined;
  }

  const ownSymbol = linker.symbolForDeclaration(source, declaration);
  if (ownSymbol === undefined) {
    diagnostics.push(
      diagnostic({
        code: "TYPE_LINK_FAILED",
        message: `Cannot establish class identity for ${exportName}.`,
        sourceSpan: declaration.span,
        help: "Keep the direct exported class declaration in the application source set.",
      }),
    );
    return undefined;
  }

  const contracts = linkedClassContracts(
    source,
    declaration,
    exportName,
    ownSymbol,
    linker,
    diagnostics,
  );
  validateLifecycleMethods(declaration, exportName, contracts, diagnostics);
  // 请求 bean 没有 context 级生命周期（ADR 0006 W7）：start action 在任何请求存在之前运行，
  // cleanup 账本按 bean 记一次——两者都以"每 bean 恰好一个实例"为前提。
  if (selection.requestScoped && (contracts.startHook || contracts.closeHook)) {
    diagnostics.push(
      diagnostic({
        code: "INVALID_LIFECYCLE_DECLARATION",
        message: `Request-scoped ${exportName} cannot implement context lifecycle interfaces.`,
        sourceSpan: declaration.span,
        help: "Remove OnContextStart/OnContextClose from the request-scoped class.",
      }),
    );
  }
  const pendingDependencies = constructorDependencies(
    implementation,
    source,
    exportName,
    linker,
    diagnostics,
  );
  const provides = dedupeSymbols(contracts.provided);
  const qualifiers = classQualifiers(provides, exportName, selection, declaration, diagnostics);
  const id = providerId(source.fileId, exportName);
  return {
    provider: {
      kind: "class",
      id,
      origin: { kind: "application", source },
      exportName,
      declarationSource: sourceReference(declaration.span),
      provides,
      scope: selection.requestScoped ? "request" : "singleton",
      primary: selection.primary,
      fallback: selection.fallback,
      eager: selection.eager,
      ...(selection.order === undefined ? {} : { order: selection.order }),
      ...(selection.role === undefined ? {} : { role: selection.role }),
      qualifiers,
      dependencies: [],
      startHook: contracts.startHook,
      closeHook: contracts.closeHook,
    },
    pendingDependencies,
  };
}
