// 中立事务契约（ADR 0008 T4，#204 定案 3）：@Transactional → 事务拦截器 → 本契约 → 各数据
// 访问库的 starter 实现，核心不依赖任何 SQL 框架。采用 scoped 回调而非 begin/commit/rollback
// 三件套：首版两个 adapter（Bun.sql、Drizzle）都是回调原生形态，且"任何 throw 回滚"由此从
// 拦截器的约定变成契约的结构性质。

// ANSI 四级闭集，可选透传（#204 定案 2）：核心不解释语义，adapter 映射到 SQL。底层不支持
// 所声明级别时 adapter 必须抛 TransactionIsolationUnsupportedError，不得静默忽略。
export const transactionIsolationLevels = [
  "READ_UNCOMMITTED",
  "READ_COMMITTED",
  "REPEATABLE_READ",
  "SERIALIZABLE",
] as const;

export type TransactionIsolation = (typeof transactionIsolationLevels)[number];

export interface TransactionOptions {
  readonly isolation?: TransactionIsolation;
}

// R 是 adapter 的事务句柄（Bun 的 TransactionSQL、Drizzle 的 tx）。数据访问入口在事务内外
// 都合法：调用时刻查 activeTransaction()，有活跃事务用 resource，否则池连接自动提交。
export interface TransactionManager<R = unknown> {
  // 每次调用在独立连接上开启一个新事务：fn 正常返回 → 提交；任何 throw → 回滚并原样重抛。
  withTransaction<T>(options: TransactionOptions, fn: (resource: R) => Promise<T>): Promise<T>;
  // savepoint 可选能力（#204 定案 3）：实现即支持 NESTED，未实现时拦截器报错不降级。
  // fn 正常返回 → release savepoint；任何 throw → 回滚到 savepoint 并原样重抛，外层事务存活。
  withSavepoint?<T>(resource: R, fn: (resource: R) => Promise<T>): Promise<T>;
}
