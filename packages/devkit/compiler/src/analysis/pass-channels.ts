import type { InterceptorBinding } from "@/analysis/interception-model";
import type { FrameworkLoggerRequest } from "@/analysis/logger-synthesis";
import type { StarterBeanModel } from "@/linking/starter-linking";
import type { ClassDeclaration } from "@/parser/source-ir";

// pass 之间的具名通道（#344 定案 2）。**闭集，不开放扩展**：这里的六条是把
// analyze-project.ts 里靠参数传递的隐式依赖逐条核出来的全部，不是一个给将来留口子的
// pub/sub。开放的消息总线会让「谁在什么时候写了什么」重新变成运行期才知道的事，而这份
// 收敛的全部意义就是把它变成注册表上可检查的静态事实。
//
// 每条通道的写者与读者写在字段注释里，`test/analysis/pass-registry.spec.ts` 的断言 A
// 按注册表下标核实「所有 reader 的下标 > 所有 writer 的最大下标」——顺序理由从此是可执行
// 检查，不是注释。

/** 解析期的候选重定向与 levels bean（logging 写，resolveProviders 读）。 */
export interface ResolutionOverrides {
  readonly redirects: Map<string, string>;
  // 「缺席 ≡ undefined」的数据字段在 eOPT 下写成 `| undefined`（#367）：写入侧是
  // `out.resolutionOverrides.levelsBeanId = loggers.levelsBeanId`，图里没有日志时它本来就是
  // undefined，收窄成 `?: string` 只会逼写入点做一次无意义的条件展开。
  levelsBeanId?: string | undefined;
}

export interface PassChannels {
  /**
   * config 已认领的 class（discover 写 → `collectProviderDrafts` 读）：认领过的不再作为普通
   * provider 复查，否则同一个类会拿到两套互相矛盾的诊断。
   */
  readonly claimedDeclarations: Set<ClassDeclaration>;
  /**
   * 需求方不在 DI 图内、必须显式入根的 starter bean（discover 写 → `resolveProviders` 读）。
   * 下游只 `has`，**禁止迭代**——迭代就把写入序变成可观测行为。
   */
  readonly demandedBeanIds: Set<string>;
  /** web 引擎 bean（discover 写 → refine 读）。 */
  readonly engineBeans: StarterBeanModel[];
  /**
   * 编译器自己点名要的 logger（discover 与 contribute 都写 → contribute 的 logging 读）。
   * 唯一的多写者通道，**消费前必须按 `name` 排序**：`applyFrameworkDemands` 是写入序
   * first-wins，web 排在 transaction 前面在收敛前纯属巧合。
   */
  readonly frameworkLoggers: FrameworkLoggerRequest[];
  /** logging 的解析期覆盖（contribute 写 → `resolveProviders` 读）。下游只 `get`，禁止迭代。 */
  readonly resolutionOverrides: ResolutionOverrides;
  /**
   * 织入链要认的拦截器绑定（contribute 写 → refine 读）。收敛前这条是跨文件硬编码：
   * `method-interception.ts` 直接 `providerById.has(transactionInterceptorBeanId)` 再就地
   * 拼一条绑定，也就是 transaction 域向 refine 的一次隐式贡献。
   */
  readonly interceptorBindings: InterceptorBinding[];
}

/**
 * 消费前必须由读者自己排序的通道（定案 4 断言 B）。
 *
 * 一条通道只要有两个以上写者，注册表下标序就成了它的写入序；下游若按写入序消费，那个顺序
 * 就变成了事实上的契约——`frameworkLoggers` 的 `applyFrameworkDemands` 正是写入序 first-wins，
 * 而「web 排在 transaction 前面」在收敛前纯属注册顺序的巧合。
 *
 * `test/analysis/pass-registry.spec.ts` 断言：注册表里每条多写通道都登记在这里。
 */
export const orderInsensitiveChannels: ReadonlySet<keyof PassChannels> = new Set([
  "frameworkLoggers",
]);

export function createPassChannels(): PassChannels {
  return {
    claimedDeclarations: new Set(),
    demandedBeanIds: new Set(),
    engineBeans: [],
    frameworkLoggers: [],
    resolutionOverrides: { redirects: new Map() },
    interceptorBindings: [],
  };
}
