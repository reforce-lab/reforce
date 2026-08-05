import type { MethodInterceptor } from "@/interception/interceptor";
import type { MethodMetaValue } from "@/interception/method-marker";

// $Woven 生成代码消费的链载体（ADR 0008 AM1，#202）：编译期已按 (phase, order, beanId)
// 压平并去重，数组顺序即外→内顺序，运行时零决策。entry.value 是该拦截器所绑标记在被织
// 方法上的字面量参数（0 参标记为 undefined）。
export interface GeneratedInterceptorEntry {
  readonly interceptor: MethodInterceptor;
  readonly value: MethodMetaValue | undefined;
}

export interface GeneratedMethodChain {
  readonly beanId: string;
  readonly method: string;
  readonly entries: readonly GeneratedInterceptorEntry[];
}

// 织入洋葱的唯一运行时入口：ctx 与 args 冻结、next() 每层至多一次（与 web composeChain
// 同款拒绝语义）、不调 next() 即短路。R 由生成代码用被织方法的 ReturnType 实例化，唯一的
// unsound 收窄集中在本函数内部——生成的 beans.ts 保持零断言。
export function invokeIntercepted<R extends Promise<unknown>>(
  chain: GeneratedMethodChain,
  args: readonly unknown[],
  terminal: () => Promise<unknown>,
): R {
  const frozenArgs = Object.freeze([...args]);
  let nextIndex = 0;
  const dispatch = async (index: number): Promise<unknown> => {
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
  // 链上任何拦截器都可替换返回值，R 的收窄由编译期硬错矩阵背书（被织方法必为 async、
  // 链形状由生成物写死），运行时无从证明 // justified: 见上
  return dispatch(0) as R;
}
