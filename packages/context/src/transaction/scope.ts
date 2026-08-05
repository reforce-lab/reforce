import { AsyncLocalStorage } from "node:async_hooks";
import type { TransactionIsolation } from "@/transaction/manager";

// 事务 ALS 仓（ADR 0008 T4，#204 定案 4）：与 request 仓分开——事务不只活在 HTTP 里，job/CLI
// 同样可用。模块级单例而非 RequestScope 的 per-context 实例：请求仓存 context 拥有的 bean
// 实例，必须随 context 走；事务记录是纯 flow-local 的 adapter 资源，不含 bean 身份，单例让
// adapter（starter bean）与拦截器都能裸 import 读到，多 context 并存时记录按 async flow
// 隔离，不串。

export interface ActiveTransaction {
  // adapter 的事务句柄，数据访问入口收窄；对用户不是容器后门——它本来就是 starter 公开的
  // 查询对象，"同一事务内裸访问"是 feature（ADR 0008 T5）。
  readonly resource: unknown;
  // 本事务开启时声明的隔离级别；undefined = 未声明（数据库默认）。加入/savepoint 边界的
  // isolation 一致性校验靠它（#204 定案 5）。
  readonly isolation: TransactionIsolation | undefined;
}

const storage = new AsyncLocalStorage<ActiveTransaction>();

// 只读访问器是唯一公开面（#204 定案 4）：数据访问入口在调用时刻查它——有活跃事务用
// resource，否则池连接；两种模式下都合法，签名不撒谎。
export function activeTransaction(): ActiveTransaction | undefined {
  return storage.getStore();
}

// 写入口不出包（index 不导出，#204 定案 4）：只有事务拦截器建立边界。嵌套边界即 ALS 影子
// 化——REQUIRES_NEW 挂起外层、NESTED 换入 savepoint resource，边界结束外层自动恢复
// （request-scope.ts 同机制）。
export function runInTransaction<T>(transaction: ActiveTransaction, callback: () => T): T {
  return storage.run(transaction, callback);
}
