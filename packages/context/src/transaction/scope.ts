import { AsyncLocalStorage } from "node:async_hooks";
import type { TransactionIsolation, TransactionManager } from "@/transaction/manager";

// 事务 ALS 仓（ADR 0008 T4，#204 定案 4）：与 request 仓分开——事务不只活在 HTTP 里，job/CLI
// 同样可用。模块级单例而非 RequestScope 的 per-context 实例：请求仓存 context 拥有的 bean
// 实例，必须随 context 走；事务记录是纯 flow-local 的 adapter 资源，不含 bean 身份，单例让
// adapter（starter bean）与拦截器都能裸 import 读到，多 context 并存时记录按 async flow
// 隔离，不串。
//
// 存的是 ReadonlyMap<manager, ActiveTransaction> 而不是单条记录：不同数据源的事务互不干扰
// ——外层 Prisma 事务里开一个 analytics 事务，期间问 Prisma 仍拿得到它自己的句柄。"多数据源
// 多 manager 延后"因此不必延后，且不需要 qualifier 字符串键（ADR 0008 T4 原判断的推翻）。
// 嵌套边界产生"旧 Map + 新条目"的新 Map，边界结束外层自动恢复。
//
// 顺带纠正一条归因：resource 曾经是 unknown 与 ALS 是单例**无关**，纯粹是当时的类型设计
// 选择。上面"为什么是模块级单例"的论证全部继续成立。

export interface ActiveTransaction {
  // adapter 的原生事务句柄。用户不裸读它——数据访问入口是 manager.current()，类型从
  // TransactionManager<R> 推得出；这里是 adapter 与拦截器的内部载体。
  readonly resource: unknown;
  // 本事务开启时声明的隔离级别；undefined = 未声明（数据库默认）。
  readonly isolation: TransactionIsolation | undefined;
  // 本事务开启时声明的墙钟上限；undefined = 未声明。加入/savepoint 边界的一致性校验靠它
  // 与 isolation（#204 定案 5）。
  readonly timeout: number | undefined;
  // 被本边界挂起的、同一 manager 上的外层资源链（最外在前）。REQUIRES_NEW 新开时断言新
  // resource 不在链上（transaction/interceptor.ts 的运行时护栏）。
  readonly suspended: readonly unknown[];
}

// 键是 manager 实例本身。声明为 object 而不是 TransactionManager<never>：R 同时出现在
// current() 的返回位与 withTransaction 回调的参数位，契约因此是 invariant 的，任何具体
// TransactionManager<R> 都不能赋给某个统一的 manager 类型——用 object 做键即可免掉一处
// 纯粹为了消解方差的断言。
type TransactionRegistry = ReadonlyMap<object, ActiveTransaction>;

const storage = new AsyncLocalStorage<TransactionRegistry>();

// 边界元信息的探查面（#204 定案 4）：只回答"在不在事务里"和边界声明了什么，不碰 resource
// 类型。需要句柄的走 manager.current()（用户）或 activeResourceFor()（adapter 作者）——
// 三个 API 职责不重叠。
export interface TransactionInfo {
  readonly isolation: TransactionIsolation | undefined;
  readonly timeout: number | undefined;
}

// 多 manager 并存时报告**最近进入**的那个 manager 的边界：Map 的插入序即首次进入序，同一
// manager 的嵌套边界覆写原位置。要问某个具体数据源的边界，用 activeResourceFor(manager)。
export function activeTransaction(): TransactionInfo | undefined {
  const registry = storage.getStore();
  if (registry === undefined) {
    return undefined;
  }
  let latest: ActiveTransaction | undefined;
  for (const record of registry.values()) {
    latest = record;
  }
  if (latest === undefined) {
    return undefined;
  }
  return { isolation: latest.isolation, timeout: latest.timeout };
}

// adapter 作者的读取原语：传 this 即从 implements TransactionManager<R> 反推 R，调用方
// 零断言——收窄发生在这里，且由类型系统而非人保证。
export function activeResourceFor<R>(manager: TransactionManager<R>): R | undefined {
  const record = activeRecordFor(manager);
  if (record === undefined) {
    return undefined;
  }
  // 键与值由 runInTransaction 成对写入，键 manager 的 R 就是值 resource 的类型；Map 无法
  // 在类型层把键的类型参数关联到值 // justified: 见上
  return record.resource as R;
}

// 以下两个不出包（index 不导出，#204 定案 4）：只有事务拦截器读记录、建立边界。
export function activeRecordFor(manager: object): ActiveTransaction | undefined {
  return storage.getStore()?.get(manager);
}

export function runInTransaction<T>(
  manager: object,
  transaction: ActiveTransaction,
  callback: () => T,
): T {
  const registry = new Map(storage.getStore());
  registry.set(manager, transaction);
  return storage.run(registry, callback);
}
