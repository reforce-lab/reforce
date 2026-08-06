import { AsyncLocalStorage } from "node:async_hooks";
import type { TransactionIsolation, TransactionManager } from "@/manager";

// 事务 ALS 仓（ADR 0008 T4，#204 定案 4）：与 request 仓分开——事务不只活在 HTTP 里，job/CLI
// 同样可用。模块级单例而非 RequestScope 的 per-context 实例：请求仓存 context 拥有的 bean
// 实例，必须随 context 走；事务记录是纯 flow-local 的 adapter 资源，不含 bean 身份，单例让
// adapter（starter bean）与拦截器都能裸 import 读到，多 context 并存时记录按 async flow
// 隔离，不串。
//
// 存的是 ReadonlyMap<manager, ActiveTransaction> 而不是单条记录，为的是让 activeResourceFor(m)
// 只回答 m 自己的句柄：外层 Prisma 事务里开一个 analytics 事务，期间问 Prisma 仍拿得到它自己的
// 那条，而不是拿到最近开的那条。嵌套边界产生"旧 Map + 新条目"的新 Map，边界结束外层自动恢复。
//
// 射程只到运行时。多数据源（#204 不做清单）指的是"编译期怎么选 manager"，这里不提供任何选
// manager 的入口——每个读取点都必须自己把 manager 传进来。
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
  // resource 不在链上（interceptor.ts 的运行时护栏）。
  readonly suspended: readonly unknown[];
}

// 键是 manager 实例本身，类型写成 object 是因为它只当身份令牌用——这张 Map 从不调键上的任何
// 方法，写 TransactionManager<never> 只会平白要求调用点解释类型实参。
type TransactionRegistry = ReadonlyMap<object, ActiveTransaction>;

const storage = new AsyncLocalStorage<TransactionRegistry>();

// 读取面的职责表（#204 定案 4 的修订，activeTransaction() 已删除）。探查恒需要钥匙：每个入口
// 都要传 manager，因为"当前事务"这个单数对象不存在——一次请求里可以有 N 条互不相关的事务栈。
//
//   我要访问数据                        → manager.current()
//   我在写 adapter，要本 manager 的句柄 → activeResourceFor(this)，且只写在 current() 的实现体里
//   我这个 manager 在不在事务里          → activeResourceFor(manager) !== undefined，不为它新增 API
//   某个边界声明了什么                   → 不出包的 activeRecordFor(manager)，包外无入口
//
// 表里故意没有"用户想知道自己在不在事务里"这一格：current() 在事务内外都返回对的句柄，用户
// 写 if-in-transaction 分支说明数据访问路径分叉了，那是 bug 不是需求。这句话必须留着，否则
// 后人会以为是漏了一个 API。

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
