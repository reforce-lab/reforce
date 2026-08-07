import type { DiagnosticArticle } from "@/explain/codes";

// 框架错误码的长文（ADR 0013 决议 3，#292）。CONTRIBUTING 的纪律是「新增任何错误码，长文与码
// 同 PR」——它要保证的是 `reforce explain <CODE>` 永不是死路，不是每个码各写一篇互相重复的
// 散文。因此这里按**码组**共享正文（一组守卫讲同一件事），summary 仍逐码一句。
//
// 单独成文件而不是并进 codes.ts：那份表是 compiler 诊断长文，两者的读者场景不同（一个是
// 「编译不过」，一个是「运行时被框架的运行期检查拦住」），混在一个 900 行的对象里没人读得动。
//
// 主体是决议 3 迁移的那批参数守卫码；CONFIG_BINDING_FAILED 是**存量**码（早于决议 2 的前缀
// 纪律，因此住在 coreErrorCodes 里），按决议 5「存量码长文按撞上频率排期补齐」一并写在这里
// ——它是启动期最常撞的一个。

const bypassingTheCompiler = [
  "Inside a compiled application you never see this: the compiler resolves defineBean statically",
  "and reports the same mistake at build time, with a source location. Reaching it at runtime",
  "means the call did not go through the compiler — a hand-written registration, a test harness,",
  "or generated output that no longer matches its sources.",
  "",
  "So the fix is usually one of two: pass what the signature asks for, or rebuild the project so",
  "the generated artifact and the sources agree again.",
];

const beanOptionGuards = [
  "defineBean takes one options object and checks every field on it before handing back a",
  "definition. The checks are not decoration — a definition that survives them is used to",
  "construct real instances later, far from the call site, where a wrong field shows up as a",
  "confusing failure instead of a clear one.",
  "",
  "The fields, and what each has to be:",
  "",
  "  create      required, a function. It is what the container calls to build the instance;",
  "              its parameters are the dependencies.",
  '  scope       optional, exactly the string "request". Omit it for a singleton.',
  "  dispose     optional, a function — and only on a singleton. Request-scoped instances are",
  "              dropped when the scope closes, so there is no disposal step to hook.",
  "  primary     optional, a boolean. Marks this provider as the default among peers.",
  "  qualifier   optional, a string literal. The name injection sites use to ask for this",
  "              provider specifically.",
  "",
  ...bypassingTheCompiler,
];

const classDecoratorArguments = [
  "@Qualifier and @Order carry values the compiler reads statically and compiles into the",
  "generated Bean — they are never looked up at runtime. That is why the argument has to be a",
  "literal of the right type rather than anything computed.",
  "",
  "@Qualifier(name) names this provider so an injection site can ask for it by name; the name is",
  "a string. @Order(order) sorts members of a collection injection, lower first, with ties and",
  "unordered members falling back to Bean id; the order is an integer.",
  "",
  ...bypassingTheCompiler,
];

const applicationOptionGuards = [
  "defineApplication takes one options object with a required `starters` array. The array is",
  "required even when it is empty: the installed set is what decides which Beans exist besides",
  "your own, so it is always written out rather than defaulted.",
  "",
  ...bypassingTheCompiler,
];

const methodMarkerGuards = [
  "A method marker is metadata, not behaviour: defineMethodMarker(key) mints the marker,",
  "@Marker(value) puts it on a method, and an @Interceptor bound to that marker supplies what",
  "actually happens. The compiler extracts the key and the literal value into the weaving table,",
  "so both have to be statically readable.",
  "",
  "  key      a non-empty string literal. It identifies the marker in the weaving table.",
  "  value    at most one argument, a JSON-shaped literal. Several fields go in one object",
  "           literal, not in several arguments.",
  "  target   a class method. Markers drive method interception, so a class or a field has",
  "           nothing for them to wrap — mark each method the aspect should cover.",
  "",
  ...bypassingTheCompiler,
];

const interceptorOptionGuards = [
  "@Interceptor binds an interceptor class to a method marker. Its options decide *which* methods",
  "the interceptor wraps and *where in the onion* it sits.",
  "",
  "  marker   required, the value defineMethodMarker() returned — not its key string, and not",
  "           the decorator that calling it produces.",
  '  phase    optional, one of "observability", "admission", "cache", "transaction",',
  '           "application". Phases are a closed, ordered set and they decide nesting:',
  "           observability is outermost, application innermost.",
  "  order    optional, an integer. It only breaks ties inside one phase; lower runs further out.",
  "",
  "Reach for the right phase before reaching for order. Ordering two aspects that belong to",
  "different phases by number works until a third aspect arrives and the numbers stop telling",
  "anyone what the intent was.",
  "",
  ...bypassingTheCompiler,
];

const requestSeedGuards = [
  "runInRequestScope opens a request scope and lets you pre-fill some of the request-scoped Beans",
  "in it. That is what a seed is: `{ target, instance }` — target names the Bean, instance is the",
  "value this one request should see for it.",
  "",
  "The rules, and why each exists:",
  "",
  "  * seeds is an array, required even when empty — the seeded set is always explicit.",
  "  * Each entry needs both a target and an object instance.",
  "  * The target must be request-scoped. A singleton is constructed once, before any request",
  "    exists, so there is no per-request slot to fill.",
  "  * For a class target the instance must be an instance of that class. Consumers are typed",
  "    against the class, so a look-alike fails at the first method they reach for.",
  "  * A target appears at most once. Two seeds for one target would make the winner depend on",
  "    array order.",
  "",
  "A target that no Bean is registered for reports UNREGISTERED_BEAN_TARGET instead.",
];

const beanFactoryReturn = [
  "The container hands whatever create() returns to every consumer of that Bean and holds it for",
  "the Context's lifetime. A primitive has no identity to share, so it cannot back a Bean — wrap",
  "the value in an object, or make the thing that needs it read it from configuration instead.",
  "",
  "On the synchronous path a Promise is refused as well. Singletons on that path are constructed",
  "in dependency order with no await between them; returning a Promise there would hand consumers",
  "a pending value that looks like the instance. A factory that genuinely has to await something",
  "belongs on the async construction path.",
];

const configPropertiesArguments = [
  "ConfigProperties(prefix, schema) declares a configuration class: the prefix decides which",
  "environment keys it reads, the schema decides what those values have to be.",
  "",
  "  prefix   dot-separated camelCase words, no leading or trailing dot. `server.http` reads",
  "           SERVER_HTTP_*. The mapping is mechanical, which is what makes the environment",
  "           surface of an application readable without opening the code.",
  "  schema   any Standard Schema v1 object (Zod, Valibot, ArkType and others all qualify) —",
  "           the schema itself, not a factory that returns one.",
  "",
  "Binding failures at startup are a different thing and report CONFIG_BINDING_FAILED: those mean",
  "the environment did not satisfy a schema that is itself well-formed.",
];

const configArtifactDefence = [
  "These two only fire when the generated artifact no longer matches the sources it was generated",
  "from. The compiler registers a config class only if it extends ConfigProperties(prefix, schema),",
  "and the type of that base forces the schema to describe an object — so at runtime neither can",
  "be false unless the artifact is stale or hand-edited.",
  "",
  "Rebuild the project. If it survives a clean rebuild, the generated output is being written by",
  "something other than the current compiler, and that is the thing to chase.",
];

const configBindingFailure = [
  "Startup binds every @ConfigProperties class before any Bean is constructed, and refuses to",
  "continue if even one of them cannot be satisfied. Failing here rather than later is deliberate:",
  "a half-configured application fails at the first request that happens to touch the missing",
  "value, in whichever environment nobody was watching.",
  "",
  "The report names, per issue, the environment key it expected, the layer it looked in, and what",
  "the schema said about the value. It never prints the value itself — configuration carries",
  "credentials, so diagnostics describe and do not echo.",
  "",
  "Two shapes of fix: the key is absent (set it in the environment or the layer that owns it), or",
  "the key is present but does not parse into the declared type — a port that arrived as an empty",
  'string, a boolean written as "yes", a number with a stray unit. Environment values are always',
  "strings on the wire, so the schema is what turns them into the declared type; widen the schema",
  "or fix the value, whichever is actually wrong.",
];

export const argumentArticles: Readonly<Record<string, DiagnosticArticle>> = {
  CONFIG_BINDING_FAILED: {
    summary: "One or more @ConfigProperties classes could not be bound at startup.",
    article: configBindingFailure,
  },
  CORE_INVALID_BEAN_OPTIONS: {
    summary: "defineBean was called with something that is not an options object.",
    article: beanOptionGuards,
  },
  CORE_MISSING_BEAN_FACTORY: {
    summary: "defineBean options carry no create function.",
    article: beanOptionGuards,
  },
  CORE_INVALID_BEAN_SCOPE: {
    summary: "defineBean scope is not the string “request”.",
    article: beanOptionGuards,
  },
  CORE_REQUEST_BEAN_DISPOSE: {
    summary: "A request-scoped defineBean declared a dispose function.",
    article: beanOptionGuards,
  },
  CORE_INVALID_BEAN_DISPOSE: {
    summary: "defineBean dispose is not a function.",
    article: beanOptionGuards,
  },
  CORE_INVALID_BEAN_PRIMARY: {
    summary: "defineBean primary is not a boolean.",
    article: beanOptionGuards,
  },
  CORE_INVALID_BEAN_QUALIFIER: {
    summary: "defineBean qualifier is not a string.",
    article: beanOptionGuards,
  },
  CORE_INVALID_QUALIFIER_NAME: {
    summary: "@Qualifier was given a name that is not a string.",
    article: classDecoratorArguments,
  },
  CORE_INVALID_ORDER_VALUE: {
    summary: "@Order was given a value that is not an integer.",
    article: classDecoratorArguments,
  },
  CORE_INVALID_APPLICATION_OPTIONS: {
    summary: "defineApplication was called with something that is not an options object.",
    article: applicationOptionGuards,
  },
  CORE_MISSING_APPLICATION_STARTERS: {
    summary: "defineApplication options carry no starters array.",
    article: applicationOptionGuards,
  },
  CORE_INVALID_METHOD_MARKER_KEY: {
    summary: "defineMethodMarker was given a key that is not a non-empty string.",
    article: methodMarkerGuards,
  },
  CORE_METHOD_MARKER_ARITY: {
    summary: "A method marker was called with more than one argument.",
    article: methodMarkerGuards,
  },
  CORE_METHOD_MARKER_TARGET: {
    summary: "A method marker was applied to something that is not a class method.",
    article: methodMarkerGuards,
  },
  CORE_INVALID_INTERCEPTOR_OPTIONS: {
    summary: "@Interceptor was called with something that is not an options object.",
    article: interceptorOptionGuards,
  },
  CORE_INVALID_INTERCEPTOR_MARKER: {
    summary: "@Interceptor marker is not a marker made by defineMethodMarker().",
    article: interceptorOptionGuards,
  },
  CORE_INVALID_INTERCEPTOR_PHASE: {
    summary: "@Interceptor phase is not one of the five known phases.",
    article: interceptorOptionGuards,
  },
  CORE_INVALID_INTERCEPTOR_ORDER: {
    summary: "@Interceptor order is not an integer.",
    article: interceptorOptionGuards,
  },
  CORE_INVALID_REQUEST_SEEDS: {
    summary: "runInRequestScope was given seeds that are not an array.",
    article: requestSeedGuards,
  },
  CORE_INVALID_REQUEST_SEED: {
    summary: "A request seed is missing its target or its object instance.",
    article: requestSeedGuards,
  },
  CORE_SEED_TARGET_NOT_REQUEST_SCOPED: {
    summary: "A request seed targets a Bean that is not request-scoped.",
    article: requestSeedGuards,
  },
  CORE_SEED_INSTANCE_TYPE_MISMATCH: {
    summary: "A request seed instance is not an instance of its class target.",
    article: requestSeedGuards,
  },
  CORE_DUPLICATE_REQUEST_SEED: {
    summary: "The same request-scoped target was seeded more than once.",
    article: requestSeedGuards,
  },
  CORE_BEAN_FACTORY_RETURN: {
    summary: "A Bean factory returned something that is not an object.",
    article: beanFactoryReturn,
  },
  CONFIG_INVALID_PROPERTIES_PREFIX: {
    summary: "A ConfigProperties prefix is not dot-separated camelCase words.",
    article: configPropertiesArguments,
  },
  CONFIG_INVALID_PROPERTIES_SCHEMA: {
    summary: "A ConfigProperties schema does not implement Standard Schema v1.",
    article: configPropertiesArguments,
  },
  CONFIG_MISSING_PROPERTIES_BASE: {
    summary: "A registered config class does not extend a ConfigProperties base.",
    article: configArtifactDefence,
  },
  CONFIG_INVALID_SCHEMA_OUTPUT: {
    summary: "A config schema validated into something that is not an object.",
    article: configArtifactDefence,
  },
};
