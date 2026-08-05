import { compareUtf16CodeUnits } from "@reforce/primitives";

// 方法级织入的分析模型（ADR 0008 AM1，#202）：weaving.json 与 $Woven emission 消费同一份
// 形状。阶段闭集与 @reforce/context 的运行时词汇同一份字面量联合（两侧封闭，扩展必须同步），
// 独立于 web 三相词汇——cache/transaction 是数据访问面的语义，不与 WebPhase 互认。

// 阶段数组顺序即链上顺序（外→内）；压平排序 = (阶段序, order, beanId)。
export const interceptPhaseOrder = [
  "observability",
  "admission",
  "cache",
  "transaction",
  "application",
] as const;

export type InterceptPhaseModel = (typeof interceptPhaseOrder)[number];

export function interceptPhaseRank(phase: InterceptPhaseModel): number {
  return interceptPhaseOrder.indexOf(phase);
}

// 与 RouteMetaValueModel 同构但不复用（#202 定案 2：Rule of Three 第二次出现保持重复）。
export type MethodMetaValueModel =
  | string
  | number
  | boolean
  | null
  | readonly MethodMetaValueModel[]
  | { readonly [key: string]: MethodMetaValueModel };

export interface InterceptorChainEntryModel {
  readonly beanId: string;
  readonly phase: InterceptPhaseModel;
  readonly order: number;
  // 该拦截器入链的来源标记 key：回答 explain 的"被谁包、为什么"（ADR 0008 不变量 2）。
  readonly markerKey: string;
  // create 改写里解析该拦截器用的 resolver 槽位：从用户构造参数之后顺延（#202 定案 5）。
  readonly parameterIndex: number;
  // 该来源标记在被织方法上的字面量参数；0 参调用记 null（JSON 无 undefined）。
  readonly value: MethodMetaValueModel | null;
}

// 链序三级决胜与 web 完全同形（#202 定案 1）：阶段序 → order → beanId。
export function compareChainEntries(
  left: { readonly phase: InterceptPhaseModel; readonly order: number; readonly beanId: string },
  right: { readonly phase: InterceptPhaseModel; readonly order: number; readonly beanId: string },
): number {
  const phase = interceptPhaseRank(left.phase) - interceptPhaseRank(right.phase);
  if (phase !== 0) {
    return phase;
  }
  const order = left.order - right.order;
  return order === 0 ? compareUtf16CodeUnits(left.beanId, right.beanId) : order;
}

export interface WovenMethodModel {
  readonly method: string;
  // 方法上出现的标记（key → 字面量参数），emission 序列化前按 key 排序；打了标记但无
  // 拦截器绑定的方法 chain 为空——标记是元数据、行为来自拦截器，表里可见即可审（#202 定案 4）。
  readonly markers: ReadonlyMap<string, MethodMetaValueModel | null>;
  // 已按 (阶段, order, beanId) 压平、按 beanId 去重（首现记 provenance）。
  readonly chain: readonly InterceptorChainEntryModel[];
}

export interface WovenBeanModel {
  readonly beanId: string;
  // $Woven 链表私有字段名：与用户类自声明成员防撞后确定。
  readonly chainFieldName: string;
  // 已按方法名排序。
  readonly methods: readonly WovenMethodModel[];
}

export interface WeavingModel {
  // 已按 beanId 排序。
  readonly beans: readonly WovenBeanModel[];
}

export const emptyWeavingModel: WeavingModel = Object.freeze({ beans: Object.freeze([]) });

// $Woven 子类挂链表的私有字段不得撞上用户类自声明成员（TS 子类不能用同名属性遮蔽基类
// 私有成员，撞名即 tsc 错误）；追加 "$" 直到避开，输入集确定则结果确定。
export function chainFieldNameFor(takenMemberNames: ReadonlySet<string>): string {
  let candidate = "interceptorChains";
  while (takenMemberNames.has(candidate)) {
    candidate = `${candidate}$`;
  }
  return candidate;
}
