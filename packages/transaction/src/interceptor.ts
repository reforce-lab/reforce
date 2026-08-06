import type { MethodInterceptor, MethodInvocationContext } from "@reforce/context";
import type { TransactionManager } from "@/manager";
import { readTransactionalValue, type TransactionalValue } from "@/marker";
import { runWithPropagation } from "@/transactional";

type TransactionalContext = MethodInvocationContext<TransactionalValue | undefined>;

// @Transactional 的唯一运行时执行者（ADR 0008 T3/T4，#204 定案 5/6）：由编译器合成注册为
// phase "transaction"、order 0 的框架 bean，传播行为编译期已知（标记字面量在织入表），这里
// 按值执行零决策。传播与记账本身在 transactional.ts——命令式入口 runTransactional 走的是同
// 一份实现，两条路的语义因此不可能漂移。
//
// ctx 直接当 TransactionSite 传：MethodInvocationContext 的 beanId/method 就是错误文案要点名
// 的那两栏，不必再抄一遍。
export class TransactionInterceptor implements MethodInterceptor<TransactionalValue | undefined> {
  constructor(private readonly manager: TransactionManager) {}

  async intercept<R>(context: TransactionalContext, next: () => Promise<R>): Promise<R> {
    return await runWithPropagation(
      this.manager,
      context,
      readTransactionalValue(context.value),
      next,
    );
  }
}
