// 错误码长文（RFC 0011 D8，#242；ADR 0013 决议 3/5 起覆盖框架错误码，#292）：诊断行与错误行
// 都只有一句话的预算，说不完「为什么会这样、结构上该怎么改」。长文住在 CLI 而不是各自的包，
// 因为它是给人读的散文，不进任何生成物，也不该让诊断/错误的构造点扛住文案长度。
//
// 纪律：新增任何错误码，长文与码同 PR（CONTRIBUTING）。没有长文的码不是错误——诊断行不会打出
// `= 详解:`，`reforce explain <CODE>` 会明确回答「暂无长文」；那是给**存量**码的过渡答案。
//
// 本表是 compiler 诊断长文；参数守卫码的长文在 @/explain/argument-articles，两者的读者场景
// 不同（一个是「编译不过」，一个是「运行时被自己写的调用参数拦住」），合成一个对象没人读得动。

import { argumentArticles } from "@/explain/argument-articles";

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
  DUPLICATE_ROUTE_MARKER: {
    summary: "Two defineRouteMarker declarations share one key.",
    article: [
      "A marker key names a slot in each route's meta table, and the key space is global to the",
      "application. Two markers sharing a key alias one slot: route.meta(A) returns whatever B",
      "wrote on that route, so middleware keyed on A silently reacts to routes marked with B.",
      "",
      "The report names both declarations. To share one marker across files, declare it once and",
      "import it everywhere; a second declaration needs a key of its own. Bare words collide",
      "easily — a dotted namespace of your own ('acme.rateLimit') is cheap insurance.",
    ],
  },
  DUPLICATE_METHOD_MARKER: {
    summary: "Two defineMethodMarker declarations share one key.",
    article: [
      "A marker key names a slot in each woven method's meta table, and the key space is global",
      "to the application. Two markers sharing a key alias one slot: an interceptor bound to A",
      "fires on methods marked with B, with B's value delivered as its context.",
      "",
      "The report names both declarations. To share one marker across files, declare it once and",
      "import it everywhere; a second declaration needs a key of its own. The key 'transactional'",
      "is reserved by the framework's @Transactional and reported separately.",
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
  SPLIT_CONTRACT_BINDING: {
    summary: "Consumers of one contract are bound through different installed copies of a package.",
    article: [
      "The same package is installed more than once, and consumers resolved the 'same' contract",
      "through different physical copies. Each copy is its own type identity (copies are never",
      "merged), so every consumer quietly got the provider living in its own copy. The graph is",
      "complete and the build succeeds — which is exactly why this is reported: the symptom (a",
      "method missing, two subsystems disagreeing about state) shows up at runtime, far from here.",
      "",
      "The report lists every binding with the copy it went through. `reforce explain <contract>`",
      "prints each installed copy and who introduced it. When the split is unintentional, align",
      "the package versions so one copy serves every consumer. When two independent subsystems",
      "really do want their own copies, suppress the report with '// reforce-ignore",
      "SPLIT_CONTRACT_BINDING: <why>' above the anchored line.",
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
  // 契约类型闭集与 checker 接入（RFC 0012 S1，#273）。
  TYPE_CHECKER_UNAVAILABLE: {
    summary: "The TypeScript checker subprocess died or was closed during this compilation.",
    article: [
      "Contract extraction consults the TypeScript checker, which runs as a tsgo subprocess owned",
      "by the compiler. This code means that subprocess crashed, was killed, or the session was",
      "closed while a compilation still needed answers from it. Nothing is wrong with your source.",
      "",
      "The session supervises itself: the next compilation spawns a fresh checker and rebuilds its",
      "project snapshot from disk, so in watch mode the next change usually just works. If the",
      "code repeats on every pass, something on the machine is killing the subprocess — look for",
      "memory pressure, sandboxing rules, or antivirus interference with the tsgo binary.",
    ],
  },
  INVALID_CONTRACT_TYPE: {
    summary: "A web contract type uses a shape outside the supported closed set.",
    article: [
      "A route contract is the wire format of an HTTP endpoint, so the compiler only accepts types",
      "it can serialize, validate, and eventually export as an OpenAPI document without guessing.",
      "That closed set is: string, number, bigint, boolean, Date, null; literal unions; arrays;",
      "plain object shapes; and discriminated object unions. Recursive types are fine as long as",
      "the cycle passes through a named type declared in your project.",
      "",
      "Everything else is rejected on purpose, not by omission:",
      "",
      "  - Built-in containers (Set, Map, typed arrays, …) have no canonical JSON form. Use plain",
      "    arrays and objects that say what actually crosses the wire.",
      "  - Functions, symbols, and template literal types cannot cross the wire at all.",
      "  - any/unknown/never/void would make the contract mean 'anything', which defeats having",
      "    a contract.",
      "  - Bare scalar unions like `string | number` cannot be told apart after serialization;",
      "    tuples serialize as arrays that lie about their element types.",
      "",
      "Rejecting is the safe direction: widening the set later is an additive change, while",
      "shipping a guessed serialization and taking it back is a breaking one.",
    ],
  },
  CONTRACT_CLASS_TYPE: {
    summary: "A class is used as a web contract; contracts must be interfaces or type aliases.",
    article: [
      "A class is a constructor plus identity plus methods. None of that survives serialization:",
      "what arrives on the other side of the wire is a plain object, and pretending it is a class",
      "instance is how 'instanceof' bugs and half-initialized objects happen.",
      "",
      "Describe the payload with an interface or type alias instead. If you have a class for",
      "domain logic, give the route a separate contract type and map explicitly at the boundary —",
      "that mapping is real code the compiler can then hold you to.",
      "",
      "This also applies to classes extending built-ins (`class MyDate extends Date`): the base",
      "Date is in the closed set, the subclass is still a class.",
    ],
  },
  CONTRACT_INDEX_SIGNATURE: {
    summary: "A web contract type has an index signature; arbitrary keys defeat the allowlist.",
    article: [
      "Response serialization projects objects through a field allowlist built from the contract",
      "(the same discipline as the route schema projector): only declared fields go out on the",
      "wire, so an accidentally leaked entity field never ships. An index signature — including",
      "Record<K, V> — says 'any key is fine', which makes that allowlist meaningless.",
      "",
      "Name the fields you actually send. When the keys are genuinely dynamic, model the data as",
      "`Array<{ key: …; value: … }>`: the pair shape is explicit, validation stays possible, and",
      "the wire format stops depending on object key enumeration.",
    ],
  },
  CONTRACT_UNION_NOT_DISCRIMINATED: {
    summary: "An object union in a web contract has no usable discriminant field.",
    article: [
      "To validate or deserialize a union of object shapes, the runtime must decide which member",
      "an incoming value is — before trusting any of its fields. Structural guessing (try each",
      "member, pick the first that fits) is order-dependent and quietly accepts overlapping",
      "shapes, so the compiler requires an explicit discriminant instead.",
      "",
      "A usable discriminant is one field that every member declares as required, holding a single",
      'string, number, or boolean literal, with a distinct value per member — `kind: "circle"`,',
      '`kind: "square"`. The diagnostic names which of these rules the closest candidate broke:',
      "optional in some member, not a single literal, or two members sharing a value.",
      "",
      'Multi-literal tags per member (`kind: "a" | "b"`) are rejected in this slice on purpose;',
      "if a real case shows up, widening is an additive change.",
    ],
  },
  // 槽位解析六类硬错与 schema 追溯（RFC 0012 S2，#274）。
  INVALID_SLOT_ANNOTATION: {
    summary: "A route handler parameter is not annotated with a recognized input slot.",
    article: [
      "Every handler parameter must say which part of the request it reads: Body<…>, Param<…>,",
      "Query<…>, Header<…> from @reforce/web, or one of the bare annotations Request,",
      "RequestContext, Headers. The compiler binds parameters to decoders by these annotations",
      "alone — an unannotated, destructured, or rest parameter gives it nothing to bind.",
      "",
      "Two situations often look surprising here:",
      "",
      "  - Destructuring (`{ id }: SomeShape`) hides the parameter name, and the name is where",
      "    the checker is asked for the type. Take a named parameter and destructure inside.",
      "  - A local type shadowing the global Request/Headers stops it being recognized; the",
      "    global built-ins are only accepted when they really resolve to the globals.",
    ],
  },
  INVALID_SLOT_KEY: {
    summary: "The first type argument of Param/Query/Header does not name exactly one key.",
    article: [
      'The single-key form takes one string literal — Param<"id", bigint> listens to exactly',
      'that key. Bare `string` names no key at all, and a literal union ("page" | "size") would',
      "make one parameter listen to several keys with one value, which has no coherent decode.",
      "",
      "Pick per intent:",
      "",
      '  - One value from one key: a single literal, optionally with a value type — Query<"page",',
      "    number>. Append `| undefined` (or use an optional value type) for an optional key.",
      "  - Several keys together: declare an object contract type and use the contract form —",
      "    Query<PageFilter> decodes each declared field.",
    ],
  },
  INVALID_SLOT_CONTRACT: {
    summary: "A slot's contract type cannot drive decoding for that slot.",
    article: [
      "The contract form of a slot annotation carries a type the compiler expands into a decoder.",
      "This code fires when that expansion cannot work for the slot it is bound to:",
      "",
      "  - A bare scalar (Param<bigint>) is ambiguous — it looks like a contract but names no",
      "    key. The diagnostic carries a machine-applicable rewrite to the single-key form.",
      "  - Param/Query/Header contracts must be object shapes; their carriers are flat key-value",
      "    text, so nested objects have no wire form there. Body accepts object, array and scalar",
      "    roots (the request body really can be any of those).",
      "  - Param and Header fields cannot be arrays — their carriers hold one value per key.",
      "    Query allows array fields (getAll semantics).",
      "  - The type itself may be outside the contract closed set; see INVALID_CONTRACT_TYPE for",
      "    what the set is and why.",
    ],
  },
  CONFLICTING_SLOT_CONTRACT: {
    summary: "One slot is bound to two contracts, or to a contract and a single key at once.",
    article: [
      "Each slot (params, query, headers, body) decodes once per request against one contract.",
      "Two parameters both claiming the whole slot — two Body bindings, two Query contract",
      "bindings, or a Query contract next to a Query single key — would need two decoders with",
      "two failure behaviors for the same bytes.",
      "",
      "Merge the declarations: put every field into one contract type and bind it once. To hand",
      "separate handler parameters separate pieces of it, bind the same contract with projection",
      'keys — Query<Filter, "page"> and Query<Filter, "size"> decode once and project twice.',
    ],
  },
  DUPLICATE_SLOT_BINDING: {
    summary: "The same key or bare annotation is bound by two handler parameters.",
    article: [
      'Two parameters reading the same single key (two Param<"id", …>) or repeating the same',
      "bare annotation (two RequestContext parameters) are almost always a copy-paste slip, and",
      "the second binding adds nothing the first does not already provide. The compiler rejects",
      "it instead of silently decoding twice.",
      "",
      "If both parameters genuinely want the value, keep one binding and share it inside the",
      "handler body.",
    ],
  },
  UNKNOWN_PATH_PARAMETER: {
    summary: "A Param key does not exist among the route path's :name segments.",
    article: [
      'Param keys come from the route pattern: @Get("/users/:id") declares exactly one, `id`.',
      "A Param single key outside that set — or a Param contract declaring a field the path",
      "never mentions — would wait for a value that cannot ever arrive; the decoder runs the",
      "whole contract, so every declared field must be reachable.",
      "",
      "Typos are the usual cause, and this is a compile error precisely because at runtime it",
      "would be a silent always-missing value. Fix the key, the path, or move the field to the",
      "slot it actually comes from (query is the usual suspect).",
    ],
  },
  INVALID_SLOT_SCHEMA: {
    summary: "A contract type traces to a value that cannot serve as its runtime schema.",
    article: [
      "When a contract type contains `typeof someValue` (z.infer<typeof s> and friends), the",
      "compiler hands decoding to that value at runtime instead of generating a decoder — so the",
      "value must be statically importable and must implement Standard Schema v1.",
      "",
      "The two failure modes:",
      "",
      "  - The value cannot be resolved to a top-level exported const in your application",
      "    sources. The generated route table imports it by module and export name; re-export",
      "    chains, locals, and property accesses (typeof shapes.user) are not importable that way.",
      "  - The value resolves but has no ~standard.validate — it is not a Standard Schema.",
      "",
      "Either export the schema value directly from an application module, or drop the typeof",
      "tracing and let the compiler generate a decoder from the type alone.",
    ],
  },
};

export function diagnosticArticle(code: string): DiagnosticArticle | undefined {
  // Object.hasOwn 而不是直接索引：query 是用户输入，"constructor" / "toString" 会在原型链上
  // 命中函数，索引出来的东西不是 DiagnosticArticle。
  if (Object.hasOwn(articles, code)) {
    return articles[code];
  }
  return Object.hasOwn(argumentArticles, code) ? argumentArticles[code] : undefined;
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
