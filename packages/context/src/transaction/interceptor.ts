import { TransactionIsolationOnJoinError, TransactionSavepointUnsupportedError } from "@/errors";
import type { MethodInterceptor, MethodInvocationContext } from "@/interception/interceptor";
import type {
  TransactionIsolation,
  TransactionManager,
  TransactionOptions,
} from "@/transaction/manager";
import { readTransactionalValue, type TransactionalValue } from "@/transaction/marker";
import { type ActiveTransaction, activeTransaction, runInTransaction } from "@/transaction/scope";

type TransactionalContext = MethodInvocationContext<TransactionalValue | undefined>;

// @Transactional 的唯一运行时执行者（ADR 0008 T3/T4，#204 定案 5/6）：由编译器合成注册为
// phase "transaction"、order 0 的框架 bean，传播行为编译期已知（标记字面量在织入表），这里
// 按值执行零决策。回滚规则：任何 throw 回滚该边界并原样重抛。REQUIRED 加入不是边界、不设
// rollback-only（与 Spring 分歧，#204 定案 5）：异常自然传播到真正开启事务的边界回滚，中途
// 用户 catch 住并正常返回即显式决定继续事务；要"内层失败只丢局部"用 NESTED。
export class TransactionInterceptor implements MethodInterceptor<TransactionalValue | undefined> {
  constructor(private readonly manager: TransactionManager) {}

  async intercept(context: TransactionalContext, next: () => Promise<unknown>): Promise<unknown> {
    const value = readTransactionalValue(context.value);
    const propagation = value?.propagation ?? "REQUIRED";
    const isolation = value?.isolation;
    const active = activeTransaction();
    // 无活跃事务时三种传播全部新开（NESTED 无外层等价 REQUIRED，Spring/Micronaut 同款）；
    // REQUIRES_NEW 恒新开独立事务，外层记录被 ALS 影子化挂起、边界结束自动恢复。
    if (active === undefined || propagation === "REQUIRES_NEW") {
      return await this.inNewTransaction(isolation, next);
    }
    this.requireJoinableIsolation(context, isolation, active);
    if (propagation === "REQUIRED") {
      return await next();
    }
    return await this.inSavepoint(context, active, next);
  }

  private async inNewTransaction(
    isolation: TransactionIsolation | undefined,
    next: () => Promise<unknown>,
  ): Promise<unknown> {
    const options: TransactionOptions = isolation === undefined ? {} : { isolation };
    return await this.manager.withTransaction(options, (resource) =>
      runInTransaction({ resource, isolation }, next),
    );
  }

  // 加入/savepoint 边界声明 isolation 且与外层不一致（含外层未声明）→ 报错不静默忽略
  // （#204 定案 5：Spring 默认静默忽略的反面）。
  private requireJoinableIsolation(
    context: TransactionalContext,
    isolation: TransactionIsolation | undefined,
    active: ActiveTransaction,
  ): void {
    if (isolation !== undefined && isolation !== active.isolation) {
      throw new TransactionIsolationOnJoinError({
        beanId: context.beanId,
        method: context.method,
        declared: isolation,
        active: active.isolation,
      });
    }
  }

  private async inSavepoint(
    context: TransactionalContext,
    active: ActiveTransaction,
    next: () => Promise<unknown>,
  ): Promise<unknown> {
    const withSavepoint = this.manager.withSavepoint;
    // 能力缺失报错不降级（#204 定案 3 / 测试 N1）：绝不在无 savepoint 保护下执行内层。
    if (withSavepoint === undefined) {
      throw new TransactionSavepointUnsupportedError({
        beanId: context.beanId,
        method: context.method,
      });
    }
    return await withSavepoint.call(this.manager, active.resource, (resource) =>
      runInTransaction({ resource, isolation: active.isolation }, next),
    );
  }
}
