// 变异开关（本包最重要的部分）：假的必须是真的——内存库实现真 MVCC，然后逐条注入"adapter
// 作者真会犯的错"，断言 TCK 精确地抓住每一条。每个开关对应一种现实中的 adapter 缺陷。
export interface MemoryMutations {
  // withTransaction 在已有事务里直接复用外层资源，不另开事务（= ORM 默认 REQUIRED 传播，
  // MikroORM 的 em.transactional 与 global EM 就是这个形态）。
  readonly reuseOuterResource?: boolean;
  // 回调抛出的值被包装成别的错误再抛。
  readonly wrapThrown?: boolean;
  // 提交阶段的错误被 catch 掉，调用方以为成功了。
  readonly swallowCommitError?: boolean;
  // 回调的返回值被包装。
  readonly wrapReturnValue?: boolean;
  // 回调抛出后仍然提交。
  readonly commitOnThrow?: boolean;
  // savepoint 只 catch 不发 ROLLBACK TO SAVEPOINT：内层的写留在缓冲里，连接进 aborted 态。
  readonly savepointCatchWithoutRollback?: boolean;
  // 接受 timeout 选项但从不执行。
  readonly ignoreTimeout?: boolean;
  // 超时了，但抛的是驱动私有错误而不是框架词汇。
  readonly driverTimeoutError?: boolean;
  // 超时错误对了，但没有回滚。
  readonly timeoutWithoutRollback?: boolean;
  // 用 statement_timeout 冒充事务超时：预算只约束单条语句，边界不受约束。
  readonly statementScopedTimeout?: boolean;
  // 累计墙钟只在发出语句时检查：不发语句就永远不超时。
  readonly wallClockCheckedAtStatements?: boolean;
  // 连接池的等待队列用模块求值期捕获的 snapshot 恢复上下文——调用方的 ALS 在此断掉。
  readonly dropAsyncContext?: boolean;
  // 未声明支持的隔离级别被静默接受。
  readonly ignoreUnsupportedIsolation?: boolean;
  // 所有级别都按 READ_COMMITTED 跑：声明了 REPEATABLE_READ 也拿不到快照。
  readonly allIsolationsAsReadCommitted?: boolean;
}
