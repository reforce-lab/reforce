import {
  TransactionIsolationOnJoinError,
  TransactionResourceReusedError,
  TransactionSavepointUnsupportedError,
  TransactionTimeoutOnJoinError,
} from "@/errors";
import type { MethodInterceptor, MethodInvocationContext } from "@/interception/interceptor";
import type {
  TransactionIsolation,
  TransactionManager,
  TransactionOptions,
} from "@/transaction/manager";
import { isNestedTransactionManager } from "@/transaction/manager";
import { readTransactionalValue, type TransactionalValue } from "@/transaction/marker";
import { type ActiveTransaction, activeRecordFor, runInTransaction } from "@/transaction/scope";

type TransactionalContext = MethodInvocationContext<TransactionalValue | undefined>;

// @Transactional 的唯一运行时执行者（ADR 0008 T3/T4，#204 定案 5/6）：由编译器合成注册为
// phase "transaction"、order 0 的框架 bean，传播行为编译期已知（标记字面量在织入表），这里
// 按值执行零决策。回滚规则：任何 throw 回滚该边界并原样重抛。REQUIRED 加入不是边界、不设
// rollback-only（与 Spring 分歧，#204 定案 5）：异常自然传播到真正开启事务的边界回滚，中途
// 用户 catch 住并正常返回即显式决定继续事务；要"内层失败只丢局部"用 NESTED。
//
// "活跃事务"按 manager 身份判定（ADR 0008 T4 多数据源定案）：加入的只可能是同一个 manager
// 已开启的边界，别的数据源的事务不构成外层。
export class TransactionInterceptor implements MethodInterceptor<TransactionalValue | undefined> {
  constructor(private readonly manager: TransactionManager) {}

  async intercept<R>(context: TransactionalContext, next: () => Promise<R>): Promise<R> {
    const value = readTransactionalValue(context.value);
    const propagation = value?.propagation ?? "REQUIRED";
    const active = activeRecordFor(this.manager);
    // 无活跃事务时三种传播全部新开（NESTED 无外层等价 REQUIRED，Spring/Micronaut 同款）；
    // REQUIRES_NEW 恒新开独立事务，外层记录被 ALS 影子化挂起、边界结束自动恢复。
    if (active === undefined || propagation === "REQUIRES_NEW") {
      return await this.inNewTransaction(context, value, active, next);
    }
    this.requireJoinableOptions(context, value, active);
    if (propagation === "REQUIRED") {
      return await next();
    }
    return await this.inSavepoint(context, active, next);
  }

  private async inNewTransaction<R>(
    context: TransactionalContext,
    value: TransactionalValue | undefined,
    suspending: ActiveTransaction | undefined,
    next: () => Promise<R>,
  ): Promise<R> {
    const isolation = value?.isolation;
    const timeout = value?.timeout;
    const options: TransactionOptions = {
      ...(isolation === undefined ? {} : { isolation }),
      ...(timeout === undefined ? {} : { timeout }),
    };
    // 被本边界挂起的、同一 manager 上的外层资源链（最外在前）。
    const suspended =
      suspending === undefined ? [] : [...suspending.suspended, suspending.resource];
    return await this.manager.withTransaction(options, (resource) => {
      requireIndependentResource(context, resource, suspended);
      return runInTransaction(this.manager, { resource, isolation, timeout, suspended }, next);
    });
  }

  // 加入/savepoint 边界声明 isolation 或 timeout 且与外层不一致（含外层未声明）→ 报错不静默
  // 忽略（#204 定案 5：Spring 默认静默忽略的反面）。timeout 同理：已开启的事务无法改超时
  // 预算，savepoint 也不是独立事务。
  private requireJoinableOptions(
    context: TransactionalContext,
    value: TransactionalValue | undefined,
    active: ActiveTransaction,
  ): void {
    const isolation: TransactionIsolation | undefined = value?.isolation;
    if (isolation !== undefined && isolation !== active.isolation) {
      throw new TransactionIsolationOnJoinError({
        beanId: context.beanId,
        method: context.method,
        declared: isolation,
        active: active.isolation,
      });
    }
    const timeout = value?.timeout;
    if (timeout !== undefined && timeout !== active.timeout) {
      throw new TransactionTimeoutOnJoinError({
        beanId: context.beanId,
        method: context.method,
        declared: timeout,
        active: active.timeout,
      });
    }
  }

  private async inSavepoint<R>(
    context: TransactionalContext,
    active: ActiveTransaction,
    next: () => Promise<R>,
  ): Promise<R> {
    // 能力缺失报错不降级（#204 定案 3 / 测试 N1）：绝不在无 savepoint 保护下执行内层。
    // 编译期已经拦掉这条路——NESTED 使用处按 NestedTransactionManager 契约解析，没有实现
    // 就是 MISSING_BEAN；这里降级为"未经编译的调用方"兜底（与 readTransactionalValue 同族）。
    if (!isNestedTransactionManager(this.manager)) {
      throw new TransactionSavepointUnsupportedError({
        beanId: context.beanId,
        method: context.method,
      });
    }
    return await this.manager.withSavepoint(active.resource, (resource) =>
      runInTransaction(
        this.manager,
        {
          resource,
          isolation: active.isolation,
          timeout: active.timeout,
          suspended: active.suspended,
        },
        next,
      ),
    );
  }
}

// 运行时护栏（ADR 0008 T4）：REQUIRES_NEW 新开时，新 resource 不得是同一 manager 上任何一层
// 被挂起边界的资源。
//
// 能力边界必须如实标注，避免后人高估：它只能抓住"直接把外层 resource 原样返回"这类粗糙实现。
// 抓不住 MikroORM 那一类——它在 savepoint 场景也会 fork 出新的 EntityManager 实例，!== 照样
// 通过而底层连接相同。真正能验证独立性的是 TCK 的 B2（内层提交后外层回滚 → 内层数据仍在）。
// 不做需要理解 ORM 内部机制的加强版护栏：那要求框架预判每个 ORM 的传播实现。
function requireIndependentResource(
  context: TransactionalContext,
  resource: unknown,
  suspended: readonly unknown[],
): void {
  if (suspended.some((outer) => Object.is(outer, resource))) {
    throw new TransactionResourceReusedError({
      beanId: context.beanId,
      method: context.method,
    });
  }
}
