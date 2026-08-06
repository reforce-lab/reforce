import type { MethodInterceptor, ReplacingMethodInterceptor } from "@/interception/interceptor";
import type { MethodMetaValue } from "@/interception/method-marker";

// $Woven 生成代码消费的链载体（ADR 0008 AM1，#202）：编译期已按 (phase, order, beanId)
// 压平并去重，数组顺序即外→内顺序，运行时零决策。entry.value 是该拦截器所绑标记在被织
// 方法上的字面量参数（0 参标记为 undefined）。
//
// R 是被织方法 await 后的返回类型，由生成物用 Awaited<ReturnType<...>> 实例化：链条与它
// 所服务的方法在类型层绑定，替换型拦截器挂错方法就在 beans.ts 过 tsc 时红。
//
// union 的两侧 T 都取 MethodMetaValue | undefined 而不是 never：union 上调用方法时参数取
// 交集，用 never 会把 ctx 塌成 MethodInvocationContext<never>，谁都传不进去。
export interface GeneratedInterceptorEntry<R> {
  readonly interceptor:
    | MethodInterceptor<MethodMetaValue | undefined>
    | ReplacingMethodInterceptor<MethodMetaValue | undefined, R>;
  readonly value: MethodMetaValue | undefined;
}

export interface GeneratedMethodChain<R> {
  readonly beanId: string;
  readonly method: string;
  readonly entries: readonly GeneratedInterceptorEntry<R>[];
}

// 织入洋葱的唯一运行时入口：ctx 与 args 冻结、next() 每层至多一次（与 web composeChain
// 同款拒绝语义）、不调 next() 即短路。链与终端都按 R 参数化，本函数内部零断言——返回类型
// 的正确性不再靠"运行时无从证明"的收窄，而是靠两个拦截器接口在类型层各自堵死。
export function invokeIntercepted<R>(
  chain: GeneratedMethodChain<Awaited<R>>,
  args: readonly unknown[],
  terminal: () => Promise<Awaited<R>>,
): Promise<Awaited<R>> {
  const frozenArgs = Object.freeze([...args]);
  let nextIndex = 0;
  const dispatch = async (index: number): Promise<Awaited<R>> => {
    if (index < nextIndex) {
      throw new Error("Interceptor called next() more than once.");
    }
    nextIndex = index + 1;
    const entry = chain.entries[index];
    if (entry === undefined) {
      return await terminal();
    }
    const context = Object.freeze({
      beanId: chain.beanId,
      method: chain.method,
      args: frozenArgs,
      value: entry.value,
    });
    return await entry.interceptor.intercept(context, () => dispatch(index + 1));
  };
  return dispatch(0);
}
