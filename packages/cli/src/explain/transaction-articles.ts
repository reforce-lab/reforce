import type { DiagnosticArticle } from "@/explain/codes";

// 事务护栏码的长文（ADR 0013 决议 5 的长文缺口，#297 第一批）。存量七码全部来自
// @reforce/transaction 的 transactionErrorCodes（ADR 0008 T3/T4，#204）。
//
// 单独成文件，理由与 argument-articles 同源：读者场景是第三种。codes.ts 那份表回答「编译不
// 过」，argument-articles 回答「运行时被自己写的调用参数拦住」，这七条回答的是「运行时被事务
// 护栏拦住，因为事务边界或 TransactionManager 的结构不对」——读者手上是一个跑起来的应用和一
// 个自己写的 manager，能做的动作（改传播、改声明位置、补 adapter 能力）跟前两组毫不重叠。
//
// 每条断言都必须在 @reforce/transaction 源码里指得出依据：护栏在 src/transactional.ts 的
// runWithPropagation / requireJoinableOptions / inSavepoint / requireIndependentResource，
// 能力判定在 src/manager.ts 的 isNestedTransactionManager，「adapter 抛、核心不抛」这条口径
// 写在 src/errors.ts 各类上方。TCK 用例编号取自 @reforce/transaction-testing。

// 共用正文（同 argument-articles 的做法：一组守卫讲同一件事，summary 仍逐码一句）。
// isolation 与 timeout 的 on-join 守卫在 requireJoinableOptions 里是同一段代码的两半，
// 结构性建议也逐字相同，分开写只会产出两篇互相重复的散文。
const joinedBoundaryOptions = [
  "Propagation decides whether a @Transactional method opens a boundary or takes part in one",
  "that is already open. This code means the method took part in an open transaction while also",
  "declaring an option that only a boundary can set. The framework refuses instead of ignoring",
  "the declaration, so that a level or a budget you wrote down is never quietly not in effect.",
  "",
  "Both properties are fixed at the moment a transaction begins: the isolation level is chosen",
  "when the transaction opens, and the time budget starts counting from the same instant. There",
  "is no point later at which an already open transaction can be told to use a different one.",
  "",
  "The check fires on two propagations:",
  "",
  "  REQUIRED  the default. With a transaction already open on this manager, the method joins",
  "            it — it is not a boundary of its own.",
  "  NESTED    opens a savepoint inside the open transaction. A savepoint gives you a local",
  "            rollback point, not an independent transaction: it runs on the same connection,",
  "            at the outer level, inside the outer budget.",
  "",
  "A mismatch against an outer boundary that declared nothing counts too. 'Nothing declared'",
  "means the database default and the adapter's default budget, which are real values the",
  "framework does not know — it cannot confirm that what you asked for is what you would get.",
  "",
  "Three ways out, in the order worth considering:",
  "",
  "  1. Move the declaration up to the method that actually opens the boundary. This is the",
  "     usual answer: the option describes the whole unit of work, so it belongs where the unit",
  "     of work starts.",
  "  2. Declare REQUIRES_NEW on this method if it genuinely needs its own level or budget.",
  "     That opens an independent transaction with its own options — and commits or rolls back",
  "     independently of the outer one, which is a real behaviour change, not a formality.",
  "  3. Drop the option and inherit whatever the outer boundary declared.",
  "",
  "'Already open' is judged per TransactionManager identity. A transaction on another data",
  "source is not an outer transaction for this one, so this code never comes from a boundary",
  "that belongs to a different manager.",
];

const savepointUnsupported = [
  "NESTED asks for a savepoint inside the transaction that is already open. Savepoints are an",
  "optional capability, and the TransactionManager that owns the open transaction does not",
  "implement withSavepoint() — the framework decides that by looking for the method on the",
  "manager, which is the same test the conformance suite uses to decide whether to register",
  "its savepoint cases.",
  "",
  "Nothing is downgraded. Running the inner method as a plain join would be the one outcome",
  "worse than failing: NESTED is chosen precisely so an inner failure can be rolled back on",
  "its own, and without a savepoint a caller that catches that failure would carry on inside a",
  "boundary whose earlier writes are already committed to it.",
  "",
  "Inside a compiled application you do not normally see this: NESTED use sites resolve against",
  "the NestedTransactionManager contract, so a manager without the capability is a MISSING_BEAN",
  "at build time with a source location. Reaching it at runtime means the call did not go",
  "through the compiler — runTransactional() with propagation NESTED, a test harness, or a",
  "generated artifact that no longer matches its sources.",
  "",
  "Two real fixes:",
  "",
  "  1. Implement withSavepoint(resource, fn) on the manager. Normal return releases the",
  "     savepoint; any throw rolls back to it and rethrows unchanged, and the outer transaction",
  "     must still be able to run statements afterwards. That last clause is the one adapters",
  "     get wrong most often — catching without issuing ROLLBACK TO SAVEPOINT leaves a",
  "     PostgreSQL connection in the aborted state, and the outer commit then fails too.",
  "  2. Change the method to REQUIRED and accept the consequence: a failure now rolls back the",
  "     whole boundary rather than just this part of it.",
];

const isolationUnsupported = [
  "The framework never throws this one. It is the vocabulary a TransactionManager uses to say",
  "'the database behind me cannot give you the level you declared'. Seeing it means your",
  "adapter did its job — the alternative would be running your unit of work at some other",
  "level while your code still says SERIALIZABLE.",
  "",
  "Silent downgrade is banned for that reason. An isolation level is a correctness statement",
  "about which anomalies your logic tolerates; a downgraded level turns it into a comment that",
  "reads as if it were enforced, and the anomaly shows up as a data bug far from here.",
  "",
  "The framework's closed set is the four ANSI levels — READ_UNCOMMITTED, READ_COMMITTED,",
  "REPEATABLE_READ, SERIALIZABLE — and the framework does not interpret them; the adapter maps",
  "them onto the database. Coverage genuinely varies: SQLite offers SERIALIZABLE and nothing",
  "else, so on SQLite the other three all land here.",
  "",
  "From the application side, the choice is real: declare a level the database actually",
  "supports, or get the guarantee some other way — an explicit lock, a uniqueness constraint,",
  "or a compare-and-set on a version column often buys what you wanted from the higher level.",
  "",
  "From the adapter side, capabilities.isolations in the conformance suite is a two-way",
  "promise: levels in the list are exercised for real, and levels outside it are asserted to",
  "throw this error rather than be downgraded. Overstating the list switches off the check",
  "that would have caught the downgrade.",
];

const timeoutUnsupported = [
  "The framework never throws this one either. A TransactionManager reports it when a declared",
  "timeout cannot be enforced as what the framework means by it: a wall-clock ceiling on the",
  "entire transaction boundary, from begin to commit.",
  "",
  "Not being able to is the normal case, not adapter sloppiness. Prisma enforces it natively",
  "and PostgreSQL 17 added transaction_timeout; PostgreSQL below 17, MySQL and SQLite have no",
  "exact equivalent. The framework treats that the same way it treats isolation coverage —",
  "capability differences are declared honestly rather than papered over.",
  "",
  "What an adapter must not do is substitute an approximation. A per-statement timeout is the",
  "tempting one and it is not equivalent: a transaction built from twenty fast statements runs",
  "straight past a statement-level limit, and so does one that opens, stops issuing statements,",
  "and sits holding its locks. The conformance suite has a case for each of those shapes.",
  "",
  "So the fix is one of:",
  "",
  "  1. Drop the timeout from this declaration. Note what that does *not* mean: no declared",
  "     timeout hands the decision to the adapter's own default, which the adapter is required",
  "     to document. Prisma's interactive transactions, for one, carry a 5000ms ceiling of",
  "     their own — an unannotated batch import is cut off in its sixth second.",
  "  2. Enforce the deadline outside the transaction, where a timer can cancel the work without",
  "     needing the database to participate.",
  "  3. Move to a database or driver that can enforce it, if the budget is a hard requirement.",
];

const timeoutExceeded = [
  "The transaction ran past its declared wall-clock budget and was rolled back. Everything it",
  "wrote is gone — this is not a partial commit, and the conformance suite asserts exactly",
  "that. The driver's own timeout error (Prisma's P2028 and its equivalents) is kept as the",
  "cause, so you can catch one framework type instead of learning each driver's error codes.",
  "",
  "Retrying only makes sense once you know why the budget ran out, and there are three usual",
  "answers:",
  "",
  "  1. Work that does not belong inside a transaction is inside it. An HTTP call, a file",
  "     upload, or waiting on a queue holds the connection and every lock the transaction has",
  "     taken for as long as it runs. Do that work before the boundary opens or after it",
  "     commits, and pass the result in.",
  "  2. The budget belongs to a different workload. A batch import that joins a boundary sized",
  "     for CRUD inherits the CRUD budget — the budget is set where the boundary opens, so the",
  "     import needs to be that boundary (REQUIRES_NEW with its own timeout) or to be started",
  "     from one.",
  "  3. The transaction spent the budget waiting rather than working, blocked on a lock another",
  "     transaction was holding. Then the fix is on the other side: shorten that transaction,",
  "     or take locks in a consistent order so the two stop queueing behind each other.",
  "",
  "The transaction boundary logger records this at debug level with the bean and method that",
  "opened the boundary, which is the quickest way to find out which boundary is timing out",
  "when the stack trace only shows the driver.",
];

const resourceReused = [
  "REQUIRES_NEW promises a transaction unrelated to any outer one: the outer boundary is",
  "suspended for the duration, and the inner one commits or rolls back on its own. This code",
  "means the guard caught withTransaction() handing back a resource that belongs to one of the",
  "outer boundaries it had just suspended — so no new transaction was begun, and the",
  "'independent' inner work would in fact commit and roll back with the outer.",
  "",
  "The cause is nearly always an ORM's own propagation or ambient context left switched on",
  "inside the adapter. That is not adapters being careless: on MikroORM the most natural",
  "implementation is wrong out of the box, because em.transactional() defaults to nested rather",
  "than a fresh transaction, and the global EntityManager reuses the surrounding context. An",
  "adapter has to explicitly bypass or disable such a mechanism.",
  "",
  "The rule for writing withTransaction() is narrow and worth stating in full: it must begin a",
  "transaction unconditionally, and it must never ask the framework for the currently active",
  "resource. That lookup belongs in exactly one place, the manager's current() method, which is",
  "supposed to return the active transaction's handle. Calling it from withTransaction() is how",
  "the outer handle gets reused.",
  "",
  "Take the guard for what it is: it compares object identity, so it catches implementations",
  "that return the outer resource as-is and nothing subtler. An adapter that wraps the same",
  "underlying connection in a fresh object passes it while still being wrong. The check that",
  "actually establishes independence is the conformance case where the inner transaction",
  "commits, the outer then rolls back, and the inner data is still there afterwards.",
];

export const transactionArticles: Readonly<Record<string, DiagnosticArticle>> = {
  TRANSACTION_SAVEPOINT_UNSUPPORTED: {
    summary: "A NESTED method needs a savepoint the active TransactionManager cannot make.",
    article: savepointUnsupported,
  },
  TRANSACTION_ISOLATION_ON_JOIN: {
    summary: "A method declared an isolation level while joining an already open transaction.",
    article: joinedBoundaryOptions,
  },
  TRANSACTION_ISOLATION_UNSUPPORTED: {
    summary: "The database cannot provide the isolation level the boundary declared.",
    article: isolationUnsupported,
  },
  TRANSACTION_TIMEOUT_ON_JOIN: {
    summary: "A method declared a timeout while joining an already open transaction.",
    article: joinedBoundaryOptions,
  },
  TRANSACTION_TIMEOUT_UNSUPPORTED: {
    summary: "The driver cannot enforce a wall-clock timeout over a whole transaction.",
    article: timeoutUnsupported,
  },
  TRANSACTION_TIMEOUT: {
    summary: "A transaction outran its declared timeout and was rolled back.",
    article: timeoutExceeded,
  },
  TRANSACTION_RESOURCE_REUSED: {
    summary: "A REQUIRES_NEW boundary was handed the suspended outer transaction's resource.",
    article: resourceReused,
  },
};
