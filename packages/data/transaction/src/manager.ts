// 中立事务契约（ADR 0008 T4，#204 定案 3）：@Transactional → 事务拦截器 → 本契约 → 应用
// 本地的 manager 类，核心不依赖任何 SQL 框架。
//
// 契约由**应用本地类**满足，不是 starter：starter 只提供连接池 bean 与配置绑定，用户写
// 二十行 manager 把 ORM 接进本契约。这不是编译器限制的副产物而是设计——"ORM 适配我们"
// 的具体形态就是这二十行，它同时是用户按住 ORM 能力差异的地方。
//
// 采用 scoped 回调而非 begin/commit/rollback 三件套：回调把"任何 throw 回滚"从拦截器的
// 约定变成契约的结构性质——拦截器根本没有"忘记 rollback"的写法。首发适配目标 Prisma 7 的
// $transaction 原生就是这个形态（T5 复议后单做 Prisma，#208 已迁离 Bun）；对需要手写
// try/catch/rollback 的驱动（node-postgres、Kysely 的 ControlledTransaction），结构保证退化
// 成 adapter 内部约定，因此 TCK 的 A2（任何 throw 都回滚且原样重抛）是必测项。

// ANSI 四级闭集，可选透传（#204 定案 2）：核心不解释语义，adapter 映射到 SQL。底层不支持
// 所声明级别时 adapter 必须抛 TransactionIsolationUnsupportedError，不得静默忽略。
// 闭集不为方言特有级别（SQL Server 的 Snapshot 等）开口子：我们表达的是数据库层几十年的
// 标准语义，方言扩展属于 adapter 自己的 API 面。
export const transactionIsolationLevels = [
  "READ_UNCOMMITTED",
  "READ_COMMITTED",
  "REPEATABLE_READ",
  "SERIALIZABLE",
] as const;

export type TransactionIsolation = (typeof transactionIsolationLevels)[number];

export interface TransactionOptions {
  readonly isolation?: TransactionIsolation;
  // 整个事务边界的墙钟时间上限（毫秒）。归属判据：一个选项属于事务边界，当且仅当取值由
  // "这个边界要做什么"决定——timeout 由"要做多少工作"决定（批量导入五分钟 vs CRUD 五秒），
  // 因此比 isolation 更是 per-boundary 属性；maxWait 由"池子多大"决定，不进契约。
  //
  // **未声明 = 交给 adapter 的默认值，adapter 必须在自己的文档里写清楚这个默认值是多少。**
  // 框架不假装"不写就是不限时"：Prisma 的 interactive transaction 自带 5000ms 上限（maxWait
  // 另有 2000ms 默认），一个不写 timeout 的批量导入会在第 6 秒被掐断——口径与 isolation 一致，
  // 能力差异由 adapter 如实声明，框架不抹平。
  //
  // adapter 只在能精确实现时才声明支持，否则抛 TransactionTimeoutUnsupportedError。明令
  // 禁止用 statement_timeout（单语句超时）这类语义不等价的近似冒充：一个由二十条快语句组成
  // 的慢事务在近似实现下照样跑满。不支持是常态而非例外——Prisma 原生支持，PG 17+ 有
  // transaction_timeout，PG <17 / MySQL / SQLite 都不能精确实现，与 isolation 已接受的形态
  // 一致（SQLite 只支持 SERIALIZABLE，其余三级全抛错）。
  readonly timeout?: number;
}

// R 是 adapter 的原生数据访问句柄（Prisma 的 TransactionClient 等）。框架不当中间人：
// 用户拿到的就是原生客户端，我们没有定义自己的词汇再翻译。
export interface TransactionManager<R = unknown> {
  // **由框架调用，不是用户入口。** adapter 实现它，事务拦截器（@Transactional）与
  // runTransactional() 调它。用户直接调等于绕开框架的账本：回调里的 service 用 current()
  // 取到的仍是池连接，那笔写落在事务外面，外层回滚它不回滚，全程无声。
  //
  // 无条件开启一个与任何外层事务无关的全新事务：fn 正常返回 → 提交；任何 throw → 回滚并
  // 原样重抛。
  //
  // 这条禁令写成"必须做什么"而不是"结果应该是什么"，因为后者 adapter 无法自证、框架无法
  // 验证：若底层 ORM 自带传播或 ambient context 机制，adapter **必须显式绕过或关闭它**；
  // 禁止依赖 ORM 的默认传播行为，也禁止在这个函数体里调 activeResourceFor(this)——拿外层的
  // 句柄接着用，"全新事务"就是假的。同一个函数在 current() 的实现体里是**必须**调的，
  // 唯一的区别就是调用位置。
  //
  // 必要性有硬证据：MikroORM 上最自然的实现 em.transactional(fn) 就是错的——它的默认传播
  // 是 NESTED 而非 REQUIRED，且 global EM / fork({useContext:true}) 会自动沿用外层上下文，
  // 于是 REQUIRES_NEW 静默退化成 savepoint。adapter 什么都不做就出错，不是 adapter 作恶。
  withTransaction<T>(options: TransactionOptions, fn: (resource: R) => Promise<T>): Promise<T>;
  // 调用时刻的数据访问句柄：本 manager 有活跃事务则返回该事务的资源，否则返回池连接。
  // 取当前连接是 manager 自己的职责——只有它知道自己的 R、知道自己的池，因此这里不设全局
  // 函数，也不需要全局类型命名空间（ADR 0008 T4/T5 的"唯一隐式"由此兑现且可静态推断）。
  // adapter 侧实现是一行且零断言：return activeResourceFor(this) ?? this.client。
  current(): R;
}

// savepoint 是可选能力，但可选性表达在**契约身份**上而非方法的 `?`：编译器据此在 NESTED
// 使用处解析 NestedTransactionManager 符号，能力缺失即编译期 MISSING_BEAN——与"图里没有
// manager"同一种诊断，而不是留到运行时抛错（#204 定案 3 的第二轮收紧）。
export interface NestedTransactionManager<R = unknown> extends TransactionManager<R> {
  // fn 正常返回 → release savepoint；任何 throw → 回滚到 savepoint 并原样重抛，外层事务存活。
  // "外层存活"含义是外层此后仍能执行语句：只 catch 不发 ROLLBACK TO SAVEPOINT 会让 PG 连接
  // 进 aborted 态，是本条最高发的 adapter bug（TCK C6）。
  withSavepoint<T>(resource: R, fn: (resource: R) => Promise<T>): Promise<T>;
}

// "怎么判定支持 savepoint"只有这一份：事务拦截器（兜未经编译的调用方）与 TCK（决定是否
// 登记 C 组用例）都用它，两处各写一遍就会漂移。
export function isNestedTransactionManager<R>(
  manager: TransactionManager<R>,
): manager is NestedTransactionManager<R> {
  return typeof Reflect.get(manager, "withSavepoint") === "function";
}
