import type { MethodInterceptor, MethodInvocationContext } from "@reforce/core";
import type { TransactionManager } from "@/manager";
import { readTransactionalValue, type TransactionalValue } from "@/marker";
import { runWithPropagation, type TransactionLogger } from "@/transactional";

type TransactionalContext = MethodInvocationContext<TransactionalValue | undefined>;

// @Transactional 的唯一运行时执行者（ADR 0008 T3/T4，#204 定案 5/6）：由编译器合成注册为
// phase "transaction"、order 0 的框架 bean，传播行为编译期已知（标记字面量在织入表），这里
// 按值执行零决策。传播与记账本身在 transactional.ts——命令式入口 runTransactional 走的是同
// 一份实现，两条路的语义因此不可能漂移。
//
// ctx 直接当 TransactionSite 传：MethodInvocationContext 的 beanId/method 就是错误文案要点名
// 的那两栏，不必再抄一遍。
export class TransactionInterceptor implements MethodInterceptor<TransactionalValue | undefined> {
  // logger 可选（RFC 0011 C5，#250）：这条边只在应用本来就绑了 LoggerFactory 时才被合成，
  // 由 compiler 的 transaction-weaving 决定。缺席即不打——不写日志的应用不该因为用了
  // @Transactional 就被迫装 @reforce/logging。拦截器持有这条边，但每个记录点都在
  // transactional.ts：传播分支只有那里知道，这里是零决策的转发。
  constructor(
    private readonly manager: TransactionManager,
    private readonly logger?: TransactionLogger,
  ) {}

  async intercept<R>(context: TransactionalContext, next: () => Promise<R>): Promise<R> {
    return await runWithPropagation(
      this.manager,
      context,
      readTransactionalValue(context.value),
      this.logger,
      next,
    );
  }
}
