import type { TransactionIsolation, TransactionManager } from "@reforce/transaction";

// adapter 作者要填的 harness（ADR 0008 T5）：TCK 只依赖 TransactionManager 契约 + 一个
// key-value 读写面，不要求 schema 知识、不要求语句日志。

export interface TransactionTckCapabilities {
  // 双向承诺：表内的级别正验（能开、能提交、能读到该有的一致性），表外的级别反验——必须抛
  // TransactionIsolationUnsupportedError，不得静默降级。
  readonly isolations: readonly TransactionIsolation[];
  // adapter 能精确实现"整个事务边界的墙钟上限"。false 时 F4/F5/F6/F7 换成 F4N：声明 timeout
  // 必须抛 TransactionTimeoutUnsupportedError。
  readonly timeout: boolean;
  // 底层允许两个写事务并发存在。SQLite 填 false：B2 降级为 B2L，B4/D3 不登记。
  readonly concurrentWriters: boolean;
  // 连接池容量。F1 的"池大小 + 5 次失败事务"没有它就没有依据。
  readonly poolSize: number;
}

// 故障注入是可选面：「获取连接失败」「提交失败」没有可移植的构造方式（deferred constraint
// 需要 schema 知识，违反"只依赖契约"）。缺席时 F2/F3 登记为 skip 并把理由写进标题——
// 跳过必须在报告里看得见。
export interface TransactionTckFaults {
  // 返回值是"将被抛出的那个错误对象"，用例据它断言错误没有被吞掉或替换。
  failNextAcquire(): Error;
  failNextCommit(): Error;
}

export interface TransactionTckHarness<R> {
  // describe 标题；多个 adapter 并存于一个测试进程时靠它区分。
  readonly name: string;
  readonly capabilities: TransactionTckCapabilities;
  readonly manager: TransactionManager<R>;
  write(resource: R, key: string, value: string): Promise<void>;
  read(resource: R, key: string): Promise<string | undefined>;
  // 必须是与任何事务无关的旁路连接。用事务内连接实现它，提交与回滚的差别就消失，B/C/D 组
  // 全部退化成永真断言。B0 做一次自检，但只挡得住最粗暴的形态。
  readOutside(key: string): Promise<string | undefined>;
  reset(): Promise<void>;
  readonly faults?: TransactionTckFaults;
}
