import type { BeanRole } from "@/analysis/bean-roles";
import type { CompilerDiagnostic } from "@/api";
import { diagnostic } from "@/diagnostics";
import type { LinkedSymbol, LinkedType } from "@/linking/model";
import type { SourceSpan } from "@/parser/source-location";
import type { ParsedSource } from "@/project/source-files";

interface GeneratedSourcePositionModel {
  readonly offset: number;
  readonly line: number;
  readonly character: number;
}

export interface GeneratedSourceReferenceModel {
  readonly file: string;
  readonly start: GeneratedSourcePositionModel;
  readonly end: GeneratedSourcePositionModel;
}

type DependencyMode = "eager" | "cycle-proxy" | "explicit-lazy" | "current";

// scope 是编译期属性（ADR 0006 W7，#142 / #151）：进模型、进生成物，运行时不做任何推断。
export type BeanScopeModel = "singleton" | "request";

export interface SingleDependencyModel {
  readonly parameterIndex: number;
  readonly targetId: string;
  // execution-plan's cycle marking rewrites "eager" to "cycle-proxy" in place after analysis,
  // so this is the only field that must stay mutable.
  mode: DependencyMode;
  readonly source: GeneratedSourceReferenceModel;
  // 该边的契约符号：emission 用它写 type-only 类型标注（ADR 0004 决策 8，#120）。只进生成的
  // import type 与 resolve<T>() 标注，不进 manifest / 运行时 JSON——序列化前必须剥掉。
  readonly contract: LinkedSymbol;
}

// 集合成员没有 explicit-lazy（Lazy<T[]> 组合形态编译期即拒，ADR 0006 W6）；mode 与单边同理
// 保持可变，execution-plan 的环标记会把成员边就地改写为 cycle-proxy。
export interface CollectionMemberModel {
  readonly targetId: string;
  mode: "eager" | "cycle-proxy";
}

// 集合边（ADR 0006 W6，#142 / #150）：members 的数组顺序即注入顺序，resolve-providers 按
// @Order 与 beanId 决胜后写死；contract 是元素契约符号，服务 resolveAll<T>() 的 typed-edge。
export interface CollectionDependencyModel {
  readonly parameterIndex: number;
  readonly members: readonly CollectionMemberModel[];
  readonly source: GeneratedSourceReferenceModel;
  readonly contract: LinkedSymbol;
}

export type DependencyModel = SingleDependencyModel | CollectionDependencyModel;

export function isCollectionDependency(
  dependency: DependencyModel,
): dependency is CollectionDependencyModel {
  return "members" in dependency;
}

// bean 的来源（ADR 0004，#120）：应用源集里的声明，或注册 starter 的 meta bean。starter bean 没有
// 应用内 span，诊断用 sourceText（包名/包内路径:行:列）文本定位，manifest 的 origin 也从这里来。
// framework（ADR 0008 AM2，#204 定案 6）：编译器合成注册的框架 bean（事务拦截器），字段形状
// 与 starter 同构——emission 的 runtimeExport 通道与 manifest origin 串写照抄，二分
// `kind === "application"` 的既有消费点全部不受影响。
export type ProviderOriginModel =
  | { readonly kind: "application"; readonly source: ParsedSource }
  | {
      readonly kind: "starter" | "framework";
      readonly origin: string;
      readonly runtimeExport: { readonly module: string; readonly export: string };
      readonly sourceText: string;
    };

export interface QualifierModel {
  readonly interfaceSymbol: LinkedSymbol;
  readonly member: string;
}

interface ProviderBase {
  readonly id: string;
  readonly origin: ProviderOriginModel;
  readonly exportName: string;
  readonly declarationSource: GeneratedSourceReferenceModel;
  readonly provides: readonly LinkedSymbol[];
  readonly scope: BeanScopeModel;
  readonly primary: boolean;
  // 源码声明带没带 @Fallback()（#343）——@Primary 的反面：同一契约还有别的候选时主动退出。
  // 只有库编译消费它，归一为 meta 的 defaultBean 字段。应用编译在入口把带标记的 provider 判为
  // 错误：应用侧候选裁决只认 starter 的 defaultBean（resolve-providers 的两处 filter），放过去
  // 就是个静默无效的注解。因此从 meta 物化的 starter provider 与框架合成 bean 恒为 false。
  readonly fallback: boolean;
  // @Order(n) 只服务集合成员排序（ADR 0006 W6）；无标记即 undefined，排在全部有序成员之后。
  readonly order?: number;
  readonly qualifiers: readonly QualifierModel[];
  readonly dependencies: DependencyModel[];
  // 框架角色（bean-roles.ts）：由角色装饰器或框架合成注册写入。角色 bean 照常构造、照常
  // 注入自己的依赖，但不进按类型解析的候选集。标记落在 provider 模型而不是解析时反查装饰器，
  // 是因为合成的事务拦截器（transaction-weaving.ts）完全绕过用户装饰器，它同样不该被谁注入。
  // 编译器内部字段，不进 generated manifest。
  readonly role?: BeanRole;
}

// 字面量构造实参（RFC 0011 L2，#242）：按构造参数位内联一个编译期已知的值，emission 里与
// 依赖表达式按 parameterIndex 归并。目前唯一的用途是把 logger 名与级别快照钉进合成的 logger
// bean——它们是编译期事实，走依赖解析既没有 provider 可指，也会让运行时多一次查表。
//
// **只进编译器模型**：不进 runtimeDependencies()、不进 manifest、不进运行时 schema，
// ADR 0004 决策 14 的「运行时 schema 一个字段不加」因此不破。
export type LiteralArgumentValue =
  | string
  | number
  | boolean
  | null
  | readonly LiteralArgumentValue[]
  | { readonly [key: string]: LiteralArgumentValue };

export interface LiteralArgumentModel {
  readonly index: number;
  readonly value: LiteralArgumentValue;
}

interface ClassProviderModel extends ProviderBase {
  readonly kind: "class";
  readonly literalArguments?: readonly LiteralArgumentModel[];
  readonly startHook: boolean;
  readonly closeHook: boolean;
}

interface FactoryProviderModel extends ProviderBase {
  readonly kind: "factory";
  readonly dispose: boolean;
}

// 配置类 provider（ADR 0005，#130）：class 身份即注入 token，与普通候选同表参选（本地恒胜、
// 可闭合 starter 开放边），但不进 constructionOrder——实例由启动期绑定 phase 先于一切 bean 构造。
export interface ConfigProviderModel extends ProviderBase {
  readonly kind: "config";
  readonly prefix: string;
}

export type ProviderModel = ClassProviderModel | FactoryProviderModel | ConfigProviderModel;
export type BeanProviderModel = ClassProviderModel | FactoryProviderModel;

export interface PendingDependency {
  readonly index: number;
  // 集合边的 linkedType 是元素契约；collection 标记决定 resolve-providers 走成员资格路径。
  readonly linkedType: LinkedType;
  readonly collection?: true;
  readonly sourceSpan: SourceSpan;
}

export interface ProviderDraft {
  readonly provider: ProviderModel;
  readonly pendingDependencies: readonly PendingDependency[];
}

export interface ExecutionPlansModel {
  readonly constructionOrder: readonly string[];
  // 第二组计划（ADR 0006 W7）：请求作用域 bean 的构造顺序，运行时每请求照单执行——请求构造
  // 时机全确定，不存在按需构造。singleton 与 config 对它恒就绪。
  readonly requestConstructionOrder: readonly string[];
  readonly startActionOrder: readonly string[];
  readonly cleanupActionOrder: readonly string[];
}

export function providerId(fileId: string, exportName: string): string {
  return `${fileId}#${exportName}`;
}

export function reportUnsupportedType(
  diagnostics: CompilerDiagnostic[],
  symbol: LinkedSymbol,
  span: SourceSpan,
): void {
  diagnostics.push(
    diagnostic({
      code: "UNSUPPORTED_TYPE_DECLARATION",
      message: `${symbol.name} resolves to a declaration kind that Reforce cannot use as a Bean contract.`,
      sourceSpan: span,
      help: "Use a directly linked non-generic class or interface as the Bean contract.",
    }),
  );
}

export function sourceReference(span: SourceSpan): GeneratedSourceReferenceModel {
  return { file: span.fileId, start: { ...span.start }, end: { ...span.end } };
}
