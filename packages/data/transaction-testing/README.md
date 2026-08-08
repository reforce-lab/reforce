# @reforce/transaction-testing

`TransactionManager` 契约的一致性测试套件（ADR 0008 T5）。adapter 作者写一个 harness，就得到
全套行为断言——契约从纸面条款变成可执行定义。

```ts
import { runTransactionTck } from "@reforce/transaction-testing";

runTransactionTck({
  name: "@reforce/data-prisma",
  capabilities: {
    isolations: ["READ_COMMITTED", "REPEATABLE_READ", "SERIALIZABLE"],
    timeout: true,
    concurrentWriters: true,
    poolSize: 10,
  },
  manager,
  write: (tx, key, value) => tx.kv.upsert(/* ... */),
  read: (tx, key) => tx.kv.findUnique(/* ... */),
  readOutside: (key) => bypassClient.kv.findUnique(/* ... */),
  reset: () => bypassClient.kv.deleteMany(),
});
```

## 为什么 vitest 在 dependencies 里

因为本包**就是**测试套件：`runTransactionTck` 直接产出 `describe`/`test`，runner 是它的消费
对象而不是宿主环境的选择（形态参照 `@keyv/test-suite`，见 `src/run.ts` 顶部注释）。装了它就
必须能跑它，不能要求每个 adapter 自己配一遍 runner。

这与 `@reforce/web-core/conformance` 的相反答案并存，两边各有理由，别把其中一个当成全仓惯例：那边
是契约包顺带提供的一个测试面，主体是给生产代码用的，为一个测试面把 runner 提成 peer 会让所有
只用契约的消费者一起付账。判据是"这个包的产物是不是测试本身"。

## harness 的三条硬要求

1. **`readOutside` 必须是与任何事务无关的旁路连接。** 用事务内连接实现它，提交与回滚的差别
   就消失，B/C/D 三组全部退化成永真断言——套件会全绿，但什么也没验证。用例 `B0` 做一次自检，
   它只挡得住最粗暴的形态。
2. **`capabilities.isolations` 是双向承诺。** 表内的级别会被正验（能开、能提交、快照语义），
   表外的级别会被反验：必须抛 `TransactionIsolationUnsupportedError`，不得静默降级。
3. **`capabilities` 如实填。** `concurrentWriters: false`（SQLite）会把 `B2` 降级成 `B2L`、
   不登记 `B4`/`D3`；`timeout: false` 会把 F4/F5/F6/F7 换成 `F4N`（声明 timeout 必须抛
   `TransactionTimeoutUnsupportedError`）。填错等于自己关掉对自己的检查。

`faults` 可选：「获取连接失败」「提交失败」没有可移植的构造方式（deferred constraint 需要
schema 知识，违反"只依赖契约"）。缺席时 `F2`/`F3` 登记为 skip，理由写进标题——跳过必须在报告
里看得见。

savepoint 没有对应的 capability 开关：`isNestedTransactionManager(manager)`（来自
`@reforce/transaction`）是唯一真相，声明只可能与它一致（冗余）或矛盾（噪声）。C 组按它自动登记。

## TCK 管不到什么

诚实地写在这里，避免"全绿 = 契约被遵守"的误读。

- **意图性条款只能验后果。**「`withTransaction()` 里禁止调 `activeResourceFor(this)`」「必须显式绕过 ORM 的传播或
  ambient context」——adapter 读了 ALS 但行为仍等价时抓不到，只有真的复用了才被 B1/B2/B3
  抓住。`B3`（两次 `withTransaction` 拿到的 resource 不同一）是最强的代理指标，但代理不是
  证明，代码评审仍要看。
- **需要 wire 级观测的都不在范围内。** 是否真的在同一条连接上 commit、失败时是否真的发了
  `ROLLBACK`（而不是只把连接丢掉）、未声明 isolation 时是否没发多余的 `SET` ——harness 契约
  没有语句日志这个口子，加进去等于要求每个 adapter 提供 wire 级探针。这几条移交 adapter 在
  自己包内用驱动日志覆盖。
- **层级不对的不在范围内。** `TransactionIsolationOnJoinError` / `TransactionTimeoutOnJoinError`
  / `TransactionSavepointUnsupportedError` 是事务拦截器的传播语义，manager 从不抛它们；由
  `@reforce/transaction` 的 `test/interceptor.spec.ts` 覆盖。
- **语义近似只能证伪不能证真。** `F5`（多条快语句组成的慢事务）与 `F6`（事务内长时间不发语句）
  各挡掉一种冒充形态，但 `statement_timeout + idle_in_transaction_session_timeout` 的组合
  可能同时通过而语义仍不完全等价。TCK 给的是**下界**。
- **隔离强度验不了全。** PG 把 `READ_UNCOMMITTED` 静默升级为 `READ_COMMITTED`，脏读不可观测；
  `SERIALIZABLE` 的写偏斜需要特定表结构，超出 key-value harness 的表达力。
- **单写者数据库验不了 REQUIRES_NEW 的写-写场景。** SQLite 上 `B2` 只能降级成 `B2L`（外层只读），
  完整验证等容器化 PG（ADR 0008 T5 的已知代价）。
- **跨 manager 不在验证范围内。** harness 只登记一个 manager，套件从不问"A 的边界里 B 看到
  什么"。ALS 按 manager 身份分槽这条性质由 `@reforce/transaction` 的 `test/scope.spec.ts`
  覆盖，与 adapter 实现无关；多数据源本身是 #204 的不做项。

## 本包自身的正确性

`test/mutations.spec.ts` 是变异矩阵：一份实现真 MVCC 的内存假 manager（committed 快照 +
每事务写缓冲 + savepoint 栈 + aborted 标志 + 有界连接池 + 真实时钟 timeout），加十四条
「adapter 作者真会犯的错」，每一条断言**精确的**失败集——少一条说明 TCK 抓不住，多一条说明
某用例在用不相干的路径附带失败、诊断价值是假的。外加一条"无变异时失败集为空"，守住"TCK 没有
过度规定"。

这层自测靠的是「用例是数据」这个结构：`TckCase` 列表加
`collectTransactionTckFailures()`，变异矩阵因此退化成同进程的循环，不需要嵌套 Vitest 进程，
也不需要解析 reporter 输出。
