// 诊断码长文（RFC 0011 D8，#242）：诊断行只有一句话的预算，说不完「为什么会这样、结构上
// 该怎么改」。长文住在 CLI 而不是编译器，因为它是给人读的散文，不进任何生成物，也不该让
// 编译器的诊断构造点扛住文案长度。
//
// 纪律：新增诊断码时长文与码同 PR（CONTRIBUTING）。没有长文的码不是错误——诊断行不会打出
// `= 详解:`，`reforce explain <CODE>` 会明确回答「暂无长文」。

export interface DiagnosticArticle {
  readonly summary: string;
  readonly article: readonly string[];
}

export const unwrittenArticleIssueUrl = "https://github.com/reforce-lab/reforce/issues/242";

// 覆盖依赖图、路由与日志/抑制三条最常撞墙的路径。其余码走「暂无长文」。
const articles: Readonly<Record<string, DiagnosticArticle>> = {
  MISSING_BEAN: {
    summary: "A dependency has no provider anywhere in the resolved graph.",
    article: [
      "The compiler resolves every constructor parameter to exactly one provider before it emits",
      "anything. This code means one parameter resolved to none.",
      "",
      "The three usual causes, in the order worth checking:",
      "",
      "  1. The provider exists but is not reachable. The compiler only sees classes exported",
      "     (transitively) from the application entry. A file nobody re-exports is invisible, even",
      "     when it sits next to one that is not.",
      "  2. The provider exists and is reachable but carries no @Injectable, so it was never a",
      "     provider to begin with.",
      "  3. The dependency is on an interface no class declares it implements. Contracts are matched",
      "     structurally by declaration, not by shape.",
      "",
      "A starter can also be the answer: a dependency on a contract a starter owns needs that",
      "starter installed and registered, otherwise nothing in the graph provides it.",
    ],
  },
  AMBIGUOUS_BEAN: {
    summary: "A dependency resolved to more than one provider with no way to pick.",
    article: [
      "Two or more providers satisfy the same contract and none of them wins on the built-in rules.",
      "The compiler refuses to guess, because guessing would make the choice depend on file order.",
      "",
      "The tie is broken, in this order:",
      "",
      "  1. Local beats installed. A provider in this application always wins over one from a",
      "     starter, and that happens without you writing anything.",
      "  2. @Primary marks one provider as the default among peers.",
      "  3. A qualifier at the injection site names exactly which provider that parameter wants.",
      "",
      "Reach for @Primary when one provider is the normal answer and the others are exceptions.",
      "Reach for a qualifier when each consumer genuinely wants a different one — @Primary plus a",
      "qualifier on the odd consumer out reads better than qualifiers everywhere.",
    ],
  },
  MULTIPLE_PRIMARY_BEANS: {
    summary: "More than one provider of the same contract is marked @Primary.",
    article: [
      "@Primary means 'this is the default one'. Two defaults is not a default, so the compiler",
      "reports it instead of picking the first.",
      "",
      "This most often happens after a starter is installed: the starter's provider is @Primary for",
      "its own contract and the application marked its own provider @Primary too. Local providers",
      "already beat installed ones without any annotation, so the application-side @Primary is",
      "usually the one to delete.",
      "",
      "When both providers really are peers, drop both @Primary marks and qualify at the injection",
      "sites instead.",
    ],
  },
  INVALID_REQUEST_SCOPE_DEPENDENCY: {
    summary: "A singleton depends directly on a request-scoped Bean.",
    article: [
      "A singleton is constructed once, before any request exists. A request-scoped Bean exists only",
      "while a request is being handled. Injecting the second into the first would have to capture",
      "one request's instance and hand it to every later request.",
      "",
      "Declare the dependency as Current<T> instead. Current<T> is a handle, not the value: it is",
      "safe to hold on a singleton, and reading it resolves the instance belonging to the request",
      "that is running right now. Reading it outside a request throws REQUEST_CONTEXT_MISSING, which",
      "is the honest answer rather than a stale instance.",
      "",
      "A request-scoped Bean depending on another request-scoped Bean is fine and needs no handle:",
      "both live for the same request.",
    ],
  },
  REQUEST_DEPENDENCY_CYCLE: {
    summary: "Request-scoped Beans depend on each other in a cycle.",
    article: [
      "Request-scoped Beans are constructed eagerly when the request scope opens, so a cycle among",
      "them has no valid construction order — unlike the singleton graph, there is no later point at",
      "which the cycle could be broken.",
      "",
      "The report names every edge in the cycle. Breaking it usually means one of:",
      "",
      "  1. Move the shared state into a third request-scoped Bean both sides depend on.",
      "  2. Turn one direction into a method parameter: pass the value at the call, instead of",
      "     injecting the caller.",
      "  3. Notice that one of the two is really a singleton and does not need request scope.",
    ],
  },
  DUPLICATE_ROUTE: {
    summary: "Two handlers claim the same method and path.",
    article: [
      "Route tables are resolved at compile time, so an ambiguous table is reported instead of being",
      "resolved by registration order at runtime. Both handler locations are named in the report.",
      "",
      "Watch for the two paths that look different but are not: a controller prefix concatenated",
      "with a handler path can collide with another controller's, and two different parameter names",
      "on the same position ('/users/:id' and '/users/:userId') are the same route — the parameter",
      "name does not take part in matching.",
    ],
  },
  ROLE_BEAN_AS_DEPENDENCY: {
    summary: "A role Bean was injected as if it were an ordinary provider.",
    article: [
      "Role Beans — controllers, interceptors, middleware — are wired by the framework at the point",
      "the role defines. They are entry points into the graph, not services other Beans consume.",
      "",
      "Injecting one is almost always a sign that the logic you want lives in the wrong place. Move",
      "the shared behaviour into a plain @Injectable service and let both the role Bean and the new",
      "consumer depend on that service instead.",
    ],
  },
  BEAN_ID_COLLISION: {
    summary: "Two providers resolved to the same Bean id.",
    article: [
      "A Bean id is 'origin#exportName'. Two providers sharing one id would make the manifest, the",
      "explain output and every diagnostic ambiguous about which one they mean.",
      "",
      "Within one application this means two exported classes with the same name reached the entry",
      "through different files. Rename one export — the file name is not part of the id, so moving",
      "files does not help.",
      "",
      "Across packages it means one starter is installed twice at incompatible versions and both",
      "copies registered. `reforce explain <bean id>` prints the introduction chain for each copy,",
      "which shows who pulled in which version.",
    ],
  },
  DUPLICATE_LOGGER_NAME: {
    summary: "Two classes resolve to the same logger name.",
    article: [
      "A logger name identifies one stream in the log output: dashboards filter on it, alert rules",
      "match on it, and LoggingSettings.levels keys on it. Two classes sharing one name would merge",
      "two unrelated streams, and tuning the level for one would silently tune the other.",
      "",
      "The default name is the class's exported name, so the usual cause is two classes with the",
      "same short name in different files — both derive the same logger. Give one of them an",
      'explicit @LoggerName("…"). The name must be a string literal: it is compiled into the',
      "generated Bean, not read at runtime.",
      "",
      "The report names both classes. Only the first keeps the name; the compilation fails rather",
      "than letting registration order decide which class owns the stream.",
    ],
  },
  UNUSED_SUPPRESSION: {
    summary: "A suppression comment matched no diagnostic on its target line.",
    article: [
      "A suppression ('// reforce-ignore <CODE>: <why>') is a standing promise that the next line",
      "reports that code. When nothing on that line reports it any more, the comment is stale —",
      "and a stale suppression is how a real regression later slips through unread.",
      "",
      "Three ways it goes stale: the diagnostic was fixed (delete the comment — this is the happy",
      "case the report exists for), the code moved lines while the comment stayed put (move the",
      "comment back onto the reporting line; suppressions may be stacked, one per line), or the",
      "code in the comment is misspelt and never matched anything.",
      "",
      "This report itself cannot be suppressed by a comment — a suppression that could hide its own",
      "staleness would make staleness undetectable. Turn it off globally with",
      "--diagnostic-level UNUSED_SUPPRESSION=off if you must.",
    ],
  },
  SUPPRESSION_NOT_APPLICABLE: {
    summary: "A suppression comment targets something a comment cannot silence.",
    article: [
      "Suppressions only apply to warnings. An error means the analysis could not produce a",
      "complete graph — past that point the compiler would be emitting constructor calls with",
      "missing arguments, so there is nothing valid to generate. Fix what the error reports; the",
      "comment cannot make the graph whole.",
      "",
      "The report also fires when the comment targets UNUSED_SUPPRESSION or",
      "SUPPRESSION_NOT_APPLICABLE themselves. Letting a comment silence the 'this suppression is",
      "stale' report would make staleness undetectable, so those two are only switchable globally",
      "via --diagnostic-level <CODE>=off.",
    ],
  },
};

export function diagnosticArticle(code: string): DiagnosticArticle | undefined {
  // Object.hasOwn 而不是直接索引：query 是用户输入，"constructor" / "toString" 会在原型链上
  // 命中函数，索引出来的东西不是 DiagnosticArticle。
  return Object.hasOwn(articles, code) ? articles[code] : undefined;
}

// 诊断行尾的 `= 详解:` 只在长文存在时打印，否则是一条走不通的指路。
export function explainCommandFor(code: string): string | undefined {
  return diagnosticArticle(code) === undefined ? undefined : `reforce explain ${code}`;
}

// 诊断码的形状（全大写加下划线）。只用于「bean 查找失败之后」判断用户是不是在问一个码，
// 不参与与 bean 面的歧义消解——那一步靠「命中长文表」，所以全大写的契约名（URL 之类）
// 不会被抢走。
const diagnosticCodeShape = /^[A-Z][A-Z0-9_]*$/u;

export function looksLikeDiagnosticCode(query: string): boolean {
  return diagnosticCodeShape.test(query);
}

export function renderDiagnosticArticle(code: string, entry: DiagnosticArticle): readonly string[] {
  return [`${code} · ${entry.summary}`, "", ...entry.article];
}
