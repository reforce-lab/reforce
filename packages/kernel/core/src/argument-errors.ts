import { defineError } from "@/define-error";

// 消息里只说"收到的是哪一类东西"，不回显值本身：参数里常有配置对象、凭据、请求体片段，
// 错误消息会进日志与终端（同 ADR 0005 决策 6.2 的脱敏约定）。
export function describeValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  return Array.isArray(value) ? "an array" : typeof value;
}

// 公开 API 的参数守卫错误（ADR 0013 决议 3，#292）。它们此前是 29 处裸 TypeError——用户最常
// 撞的一层，却是全仓唯一没有码、没有 help、不进 isReforceError 识别的一层。
//
// 集中在一个文件而不是散在各自的声明模块旁：它们是同一类东西（"调用方给错了"），码表要一眼
// 数得清，help 的措辞要能横向对齐。抛出点仍在各自模块，这里只放定义。
//
// base 一律 TypeError：现状就是 TypeError，改成 RangeError（Order / order 的整数校验语义上更
// 准）会改变用户已有 `catch (e) { if (e instanceof TypeError) … }` 的行为，属与本步无关的破坏。

const passTheClassItself =
  "Pass the value the signature asks for. These guards exist for callers that bypass the compiler — inside a compiled application the compiler reports the same mistake at build time, with a source location.";

export const InvalidBeanOptionsError = defineError<"CORE_INVALID_BEAN_OPTIONS", [received: string]>(
  "CORE_INVALID_BEAN_OPTIONS",
  "defineBean options must be an object, received %s.",
  { base: TypeError, help: passTheClassItself },
);

export const MissingBeanFactoryError = defineError<"CORE_MISSING_BEAN_FACTORY">(
  "CORE_MISSING_BEAN_FACTORY",
  "defineBean requires a create function.",
  {
    base: TypeError,
    help: "create() is what the container calls to build the Bean. Give it a function that returns the instance; declare dependencies as its parameters.",
  },
);

export const InvalidBeanScopeError = defineError<"CORE_INVALID_BEAN_SCOPE", [received: string]>(
  "CORE_INVALID_BEAN_SCOPE",
  'defineBean scope must be the string "request" when provided, received %s.',
  {
    base: TypeError,
    help: 'The scope vocabulary is closed: omit it for a singleton, or pass "request" for one instance per request.',
  },
);

export const RequestBeanDisposeError = defineError<"CORE_REQUEST_BEAN_DISPOSE">(
  "CORE_REQUEST_BEAN_DISPOSE",
  "defineBean dispose is not available on a request-scoped Bean.",
  {
    base: TypeError,
    help: "Request-scoped instances are dropped when the request scope closes, so there is no disposal step to hook. Release per-request resources at the end of the work that acquired them.",
  },
);

export const InvalidBeanDisposeError = defineError<"CORE_INVALID_BEAN_DISPOSE", [received: string]>(
  "CORE_INVALID_BEAN_DISPOSE",
  "defineBean dispose must be a function when provided, received %s.",
  {
    base: TypeError,
    help: "dispose receives the instance create() returned and runs once during Context close.",
  },
);

export const InvalidBeanPrimaryError = defineError<"CORE_INVALID_BEAN_PRIMARY", [received: string]>(
  "CORE_INVALID_BEAN_PRIMARY",
  "defineBean primary must be a boolean when provided, received %s.",
  {
    base: TypeError,
    help: "primary marks this provider as the default among peers of the same contract. Omit it unless two or more providers compete.",
  },
);

export const InvalidBeanQualifierError = defineError<
  "CORE_INVALID_BEAN_QUALIFIER",
  [received: string]
>(
  "CORE_INVALID_BEAN_QUALIFIER",
  "defineBean qualifier must be a string when provided, received %s.",
  {
    base: TypeError,
    help: "A qualifier is the name injection sites use to ask for this provider specifically. It must be a string literal so the compiler can match it at build time.",
  },
);

export const InvalidQualifierNameError = defineError<
  "CORE_INVALID_QUALIFIER_NAME",
  [received: string]
>("CORE_INVALID_QUALIFIER_NAME", "Qualifier name must be a string, received %s.", {
  base: TypeError,
  help: "The name must be a string literal: the compiler reads it statically and compiles the match into the generated Bean, it is not looked up at runtime.",
});

export const InvalidOrderValueError = defineError<"CORE_INVALID_ORDER_VALUE", [received: string]>(
  "CORE_INVALID_ORDER_VALUE",
  "Order value must be an integer, received %s.",
  {
    base: TypeError,
    help: "@Order only sorts members of a collection injection: lower values come first, ties and unordered members fall back to Bean id.",
  },
);

export const InvalidApplicationOptionsError = defineError<
  "CORE_INVALID_APPLICATION_OPTIONS",
  [received: string]
>("CORE_INVALID_APPLICATION_OPTIONS", "defineApplication options must be an object, received %s.", {
  base: TypeError,
  help: passTheClassItself,
});

export const MissingApplicationStartersError = defineError<"CORE_MISSING_APPLICATION_STARTERS">(
  "CORE_MISSING_APPLICATION_STARTERS",
  "defineApplication requires a starters array.",
  {
    base: TypeError,
    help: "Pass an empty array when the application installs no starter; the key itself is required so the registration list is always explicit.",
  },
);

export const InvalidMethodMarkerKeyError = defineError<
  "CORE_INVALID_METHOD_MARKER_KEY",
  [received: string]
>(
  "CORE_INVALID_METHOD_MARKER_KEY",
  "defineMethodMarker key must be a non-empty string, received %s.",
  {
    base: TypeError,
    help: "The key identifies this marker in the generated weaving table, so it must be a non-empty string literal known at build time.",
  },
);

export const MethodMarkerArityError = defineError<"CORE_METHOD_MARKER_ARITY", [key: string]>(
  "CORE_METHOD_MARKER_ARITY",
  'method marker "%s" accepts at most one literal value.',
  {
    base: TypeError,
    help: "A marker carries either nothing or a single literal value. Put several fields in one object literal instead of passing several arguments.",
  },
);

export const MethodMarkerTargetError = defineError<"CORE_METHOD_MARKER_TARGET", [key: string]>(
  "CORE_METHOD_MARKER_TARGET",
  'method marker "%s" can only decorate a class method.',
  {
    base: TypeError,
    help: "Method markers drive method interception, so they only mean something on a method. To mark a whole class, apply the marker to each method the aspect should wrap.",
  },
);

export const InvalidInterceptorOptionsError = defineError<
  "CORE_INVALID_INTERCEPTOR_OPTIONS",
  [received: string]
>("CORE_INVALID_INTERCEPTOR_OPTIONS", "Interceptor options must be an object, received %s.", {
  base: TypeError,
  help: passTheClassItself,
});

export const InvalidInterceptorMarkerError = defineError<"CORE_INVALID_INTERCEPTOR_MARKER">(
  "CORE_INVALID_INTERCEPTOR_MARKER",
  "Interceptor marker must be a method marker created by defineMethodMarker().",
  {
    base: TypeError,
    help: "The marker is what binds this interceptor to methods. Pass the marker value itself, not its key string and not the decorator it returns.",
  },
);

export const InvalidInterceptorPhaseError = defineError<
  "CORE_INVALID_INTERCEPTOR_PHASE",
  [received: string]
>(
  "CORE_INVALID_INTERCEPTOR_PHASE",
  'Interceptor phase must be "observability", "admission", "cache", "transaction", or "application", received %s.',
  {
    base: TypeError,
    help: "Phases are a closed, ordered set: they decide which interceptor wraps which, outermost first. Pick the phase your aspect belongs to rather than tuning order across unrelated aspects.",
  },
);

export const InvalidInterceptorOrderError = defineError<
  "CORE_INVALID_INTERCEPTOR_ORDER",
  [received: string]
>(
  "CORE_INVALID_INTERCEPTOR_ORDER",
  "Interceptor order must be an integer when provided, received %s.",
  {
    base: TypeError,
    help: "order only breaks ties inside one phase; lower runs further out. Across phases the phase always wins, so reach for the right phase before reaching for order.",
  },
);

export const InvalidRequestSeedsError = defineError<
  "CORE_INVALID_REQUEST_SEEDS",
  [received: string]
>("CORE_INVALID_REQUEST_SEEDS", "runInRequestScope seeds must be an array, received %s.", {
  base: TypeError,
  help: "Pass an empty array when the scope needs no seed; the argument itself is required so the seeded set is always explicit.",
});

export const InvalidRequestSeedError = defineError<"CORE_INVALID_REQUEST_SEED">(
  "CORE_INVALID_REQUEST_SEED",
  "Each request seed needs a target and an object instance.",
  {
    base: TypeError,
    help: "A seed is `{ target, instance }`: target names the request-scoped Bean, instance is the value this request should see for it.",
  },
);

export const SeedTargetNotRequestScopedError = defineError<
  "CORE_SEED_TARGET_NOT_REQUEST_SCOPED",
  [beanId: string]
>("CORE_SEED_TARGET_NOT_REQUEST_SCOPED", 'Seed target "%s" is not a request-scoped Bean.', {
  base: TypeError,
  help: "Only request-scoped Beans can be seeded — a singleton is constructed once, before any request exists, so there is no per-request slot to fill.",
});

export const SeedInstanceTypeMismatchError = defineError<
  "CORE_SEED_INSTANCE_TYPE_MISMATCH",
  [beanId: string]
>(
  "CORE_SEED_INSTANCE_TYPE_MISMATCH",
  'Seed instance for "%s" must be an instance of its class target.',
  {
    base: TypeError,
    help: "Consumers of this Bean are typed against the class, so a look-alike object would fail the first time one of them reaches for a method the class declares.",
  },
);

export const DuplicateRequestSeedError = defineError<
  "CORE_DUPLICATE_REQUEST_SEED",
  [beanId: string]
>("CORE_DUPLICATE_REQUEST_SEED", 'Seed target "%s" appears more than once.', {
  base: TypeError,
  help: "Two seeds for one target would make the winner depend on array order. Keep the one this request should see and drop the other.",
});

export const BeanFactoryReturnError = defineError<"CORE_BEAN_FACTORY_RETURN", [qualifier: string]>(
  "CORE_BEAN_FACTORY_RETURN",
  "Bean creation must %sreturn an object.",
  {
    base: TypeError,
    help: "The container hands the returned value to every consumer of this Bean and holds it for the Context's lifetime, so it has to be an object — a primitive has no identity to share.",
  },
);
