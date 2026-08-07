import {
  TransactionIsolationOnJoinError,
  TransactionResourceReusedError,
  TransactionSavepointUnsupportedError,
  TransactionTimeoutError,
  TransactionTimeoutOnJoinError,
} from "@/errors";
import type { TransactionIsolation, TransactionManager, TransactionOptions } from "@/manager";
import { isNestedTransactionManager } from "@/manager";
import { readTransactionalValue, type TransactionalValue } from "@/marker";
import { type ActiveTransaction, activeRecordFor, runInTransaction } from "@/scope";

// 传播与记账的唯一实现（ADR 0008 T3/T4，#204 定案 5）。两个入口共用它：@Transactional 走
// TransactionInterceptor，job/CLI 里的命令式边界走下面的 runTransactional。这不是"顺手复用"
// ——它们必须是同一份代码：账本（ALS 记录）只有走过这里才写得上，用户绕开框架直接调
// manager.withTransaction(...) 时，回调里的 service 用 current() 取到的是池连接，那笔写落在
// 事务外面，外层回滚它不回滚，全程无声。
//
// 回滚规则：任何 throw 回滚该边界并原样重抛。REQUIRED 加入不是边界、不设 rollback-only
//（与 Spring 分歧，#204 定案 5）：异常自然传播到真正开启事务的边界回滚，中途用户 catch 住并
// 正常返回即显式决定继续事务；要"内层失败只丢局部"用 NESTED。
//
// "活跃事务"按 manager 身份判定（ADR 0008 T4 多数据源定案）：加入的只可能是同一个 manager
// 已开启的边界，别的数据源的事务不构成外层。

// 出错时点名"是谁开的这个边界"。被织方法有 beanId/method 两栏（MethodInvocationContext 直接
// 满足这个形状）；命令式入口没有被织方法，用下面那个固定值占位。
export interface TransactionSite {
  readonly beanId: string;
  readonly method: string;
}

// 事务日志要的最小 logger 形状，由**消费侧**定义（RFC 0011 C5，#250；同 web 侧的
// RequestLogger 与 runtime 侧的 ShutdownLogger）。
//
// 不写 `import type { Logger } from "@reforce/logging"`：type-only import 会留在发布出去的
// d.ts 里，那样每个用 @Transactional 的应用光是 typecheck 就得装上 logging。@reforce/logging
// 的 Logger 结构性满足这个形状，生成的 beans.ts 把真实例传进来。
type LogFields = Readonly<Record<string, unknown>> | undefined;

export interface TransactionLogger {
  isEnabled(level: "debug"): boolean;
  debug(fields: LogFields, message: string): void;
}

// 事务边界的耗时，3 位小数，与请求日志的 handlerMs 同精度。
function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 1000) / 1000;
}

// 边界失败降 **debug** 后原样重抛（Spring 对位；RFC 0011 打磨，#242）：异常会一路传播，
// 真 500 的 error 已由 error-dispatch 与请求日志记账，这里再发一条 error 就是一次失败三条
// error 的重复报告。debug 档要的是「回滚发生在哪个边界」的排查现场，判定在字段构造之前
//（不变量 8）。
//
// 与 web 侧 500 兜底的关键分歧：那边 logger 抛了就吞掉，因为 dispatchError 永不 reject 是
// 适配器契约；这边吞掉会让一个坏 logger **顶替**业务错误，所以原错照抛，日志故障单独落
// stderr——最吵，但不改变调用方看到的错误。
// 一次判定、一处使用：把「要不要打」和「打什么」收在一起，调用点就只剩一句。判定仍在字段
// 字面量之前（不变量 8）——它是这个函数的第一条语句。
function debugBoundary(
  logger: TransactionLogger | undefined,
  message: string,
  fields: () => Readonly<Record<string, unknown>>,
): void {
  if (logger === undefined || !logger.isEnabled("debug")) {
    return;
  }
  logger.debug(fields(), message);
}

function reportBoundaryFailure(
  logger: TransactionLogger,
  site: TransactionSite,
  error: unknown,
  message: string,
): void {
  try {
    if (!logger.isEnabled("debug")) {
      return;
    }
    logger.debug(
      {
        beanId: site.beanId,
        method: site.method,
        // err 是保留字段名：pino/bunyan/OTel 都按它特判 Error 序列化。
        err: error,
        ...(error instanceof TransactionTimeoutError ? { timeout: error.timeout } : {}),
      },
      error instanceof TransactionTimeoutError ? "transaction timeout" : message,
    );
  } catch (loggingFailure) {
    process.stderr.write(
      `[reforce.transaction] the boundary logger failed: ${String(loggingFailure)}\n`,
    );
  }
}

export async function runWithPropagation<R>(
  manager: TransactionManager,
  site: TransactionSite,
  value: TransactionalValue | undefined,
  logger: TransactionLogger | undefined,
  fn: () => Promise<R>,
): Promise<R> {
  const propagation = value?.propagation ?? "REQUIRED";
  const active = activeRecordFor(manager);
  // 无活跃事务时三种传播全部新开（NESTED 无外层等价 REQUIRED，Spring/Micronaut 同款）；
  // REQUIRES_NEW 恒新开独立事务，外层记录被 ALS 影子化挂起、边界结束自动恢复。
  if (active === undefined || propagation === "REQUIRES_NEW") {
    return await inNewTransaction(manager, site, value, propagation, active, logger, fn);
  }
  requireJoinableOptions(site, value, active);
  if (propagation === "REQUIRED") {
    // 加入不是边界（见文件头的回滚规则），所以只有 join 一条、没有 commit/rollback 配对——
    // 发了会让告警规则把外层边界的结果重复计一遍。
    debugBoundary(logger, "transaction join", () => ({
      beanId: site.beanId,
      method: site.method,
    }));
    return await fn();
  }
  return await inSavepoint(manager, site, active, logger, fn);
}

// 命令式入口的占位站点：错误文案里读到 "runTransactional.callback" 就知道这条边界不是某个
// @Transactional 方法开的，而是有人手写了 runTransactional(...)。
const imperativeSite: TransactionSite = { beanId: "runTransactional", method: "callback" };

// job / CLI / 启动钩子里开事务的入口（#204 定案 3 的补齐）：与 @Transactional 语义完全一致，
// 因为是同一份代码。TransactionManager.withTransaction 是给 adapter 实现、给框架调用的，
// 用户不直接调它——直接调等于绕开账本。
//
//   await runTransactional(manager, { timeout: 600_000 }, async () => {
//     await this.importer.loadProducts();   // 内部 current() 拿到本次边界的句柄
//   });
//
// options 与 @Transactional 的字面量同形（propagation / isolation / timeout），并走同一个
// 运行时守卫：命令式入口的实参没经过编译期 schema 校验，非法值在这里就抛 TypeError。
export async function runTransactional<T>(
  manager: TransactionManager,
  options: TransactionalValue | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  // 命令式入口没有容器，拿不到 logger：它没有 DI 边。给它一条意味着把 logger 加进这个公开
  // 签名，没人要过（RFC 0011 C5，#250）。
  return await runWithPropagation(
    manager,
    imperativeSite,
    readTransactionalValue(options),
    undefined,
    fn,
  );
}

async function inNewTransaction<R>(
  manager: TransactionManager,
  site: TransactionSite,
  value: TransactionalValue | undefined,
  propagation: string,
  suspending: ActiveTransaction | undefined,
  logger: TransactionLogger | undefined,
  fn: () => Promise<R>,
): Promise<R> {
  const isolation = value?.isolation;
  const timeout = value?.timeout;
  const options: TransactionOptions = {
    ...(isolation === undefined ? {} : { isolation }),
    ...(timeout === undefined ? {} : { timeout }),
  };
  // 被本边界挂起的、同一 manager 上的外层资源链（最外在前）。
  const suspended = suspending === undefined ? [] : [...suspending.suspended, suspending.resource];
  debugBoundary(logger, "transaction begin", () => ({
    beanId: site.beanId,
    method: site.method,
    propagation,
    ...(isolation === undefined ? {} : { isolation }),
    ...(timeout === undefined ? {} : { timeout }),
    // 「这条 REQUIRES_NEW 挂起了一个外层边界」正是 ADR 0008 T4 那个隐患本身。
    ...(suspending === undefined ? {} : { suspended: true }),
  }));
  const startedAt = performance.now();
  try {
    const result = await manager.withTransaction(options, (resource) => {
      requireIndependentResource(site, resource, suspended);
      return runInTransaction(manager, { resource, isolation, timeout, suspended }, fn);
    });
    debugBoundary(logger, "transaction commit", () => ({
      beanId: site.beanId,
      method: site.method,
      ms: elapsedMs(startedAt),
    }));
    return result;
  } catch (error) {
    // 这是适配器的回滚唯一能被看见的地方：本文件全程没有 try/catch，回滚由 adapter 做完再
    // 原样重抛（见文件头）。
    if (logger !== undefined) {
      reportBoundaryFailure(logger, site, error, "transaction rollback");
    }
    throw error;
  }
}

// 加入/savepoint 边界声明 isolation 或 timeout 且与外层不一致（含外层未声明）→ 报错不静默
// 忽略（#204 定案 5：Spring 默认静默忽略的反面）。timeout 同理：已开启的事务无法改超时
// 预算，savepoint 也不是独立事务。
function requireJoinableOptions(
  site: TransactionSite,
  value: TransactionalValue | undefined,
  active: ActiveTransaction,
): void {
  const isolation: TransactionIsolation | undefined = value?.isolation;
  if (isolation !== undefined && isolation !== active.isolation) {
    throw new TransactionIsolationOnJoinError({
      beanId: site.beanId,
      method: site.method,
      declared: isolation,
      active: active.isolation,
    });
  }
  const timeout = value?.timeout;
  if (timeout !== undefined && timeout !== active.timeout) {
    throw new TransactionTimeoutOnJoinError({
      beanId: site.beanId,
      method: site.method,
      declared: timeout,
      active: active.timeout,
    });
  }
}

async function inSavepoint<R>(
  manager: TransactionManager,
  site: TransactionSite,
  active: ActiveTransaction,
  logger: TransactionLogger | undefined,
  fn: () => Promise<R>,
): Promise<R> {
  // 能力缺失报错不降级（#204 定案 3 / 测试 N1）：绝不在无 savepoint 保护下执行内层。
  // 编译期已经拦掉这条路——NESTED 使用处按 NestedTransactionManager 契约解析，没有实现
  // 就是 MISSING_BEAN；这里降级为"未经编译的调用方"兜底（与 readTransactionalValue 同族）。
  if (!isNestedTransactionManager(manager)) {
    throw new TransactionSavepointUnsupportedError({
      beanId: site.beanId,
      method: site.method,
    });
  }
  // 四个守卫错误（能力缺失、加入选项冲突、资源复用）都在任何事务动作之前抛出、且文案已经
  // 完整，这里不记——记了就是重复报告。
  debugBoundary(logger, "transaction savepoint", () => ({
    beanId: site.beanId,
    method: site.method,
  }));
  const startedAt = performance.now();
  try {
    const result = await manager.withSavepoint(active.resource, (resource) =>
      runInTransaction(
        manager,
        {
          resource,
          isolation: active.isolation,
          timeout: active.timeout,
          suspended: active.suspended,
        },
        fn,
      ),
    );
    debugBoundary(logger, "transaction savepoint release", () => ({
      beanId: site.beanId,
      method: site.method,
      ms: elapsedMs(startedAt),
    }));
    return result;
  } catch (error) {
    // savepoint 的释放/回滚是**局部回滚**唯一可见的地方，也正是一致性套件 C6 要保护的那对。
    if (logger !== undefined) {
      reportBoundaryFailure(logger, site, error, "transaction savepoint rollback");
    }
    throw error;
  }
}

// 运行时护栏（ADR 0008 T4）：REQUIRES_NEW 新开时，新 resource 不得是同一 manager 上任何一层
// 被挂起边界的资源。
//
// 能力边界必须如实标注，避免后人高估：它只能抓住"直接把外层 resource 原样返回"这类粗糙实现。
// 抓不住 MikroORM 那一类——它在 savepoint 场景也会 fork 出新的 EntityManager 实例，!== 照样
// 通过而底层连接相同。真正能验证独立性的是一致性套件的 B2（内层提交后外层回滚 → 内层数据仍在）。
// 不做需要理解 ORM 内部机制的加强版护栏：那要求框架预判每个 ORM 的传播实现。
function requireIndependentResource(
  site: TransactionSite,
  resource: unknown,
  suspended: readonly unknown[],
): void {
  if (suspended.some((outer) => Object.is(outer, resource))) {
    throw new TransactionResourceReusedError({
      beanId: site.beanId,
      method: site.method,
    });
  }
}
