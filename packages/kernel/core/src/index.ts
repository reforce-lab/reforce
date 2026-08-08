export {
  type ApplicationDefinition,
  type DefineApplicationOptions,
  defineApplication,
  defineStarter,
  type StarterDefinition,
} from "@/application-declaration";
export {
  defineBean,
  Eager,
  Fallback,
  Injectable,
  Order,
  Primary,
  Qualifier,
  RequestScoped,
} from "@/bean-declaration";
export { type CoreErrorCode, coreErrorCodes } from "@/error-codes";
export * as errors from "@/error-namespace";
export {
  ApplicationCleanupError,
  ApplicationContextStateError,
  ApplicationStartError,
  BeanCreationError,
  BeanDisposalError,
  BeanLifecycleError,
  ConfigBindingError,
  type ConfigBindingIssue,
  EarlyBeanAccessError,
  InterceptorReenteredError,
  InvalidGeneratedDefinitionError,
  isReforceError,
  ReforceError,
  type ReforceErrorOptions,
  RequestContextMissingError,
  UnregisteredBeanTargetError,
} from "@/errors";
export {
  type InterceptHandle,
  Interceptor,
  type InterceptorOptions,
  type InterceptPhase,
  interceptPhases,
  type MethodInterceptor,
  type MethodInvocationContext,
  type ReplacingInterceptHandle,
  type ReplacingMethodInterceptor,
} from "@/interception/interceptor";
export {
  defineMethodMarker,
  type MethodMarker,
  type MethodMetaValue,
} from "@/interception/method-marker";
export type {
  ApplicationContext,
  BeanClass,
  BeanDefinition,
  BeanTiming,
  BeanTimingPhase,
  ContextStartReport,
  Current,
  Lazy,
  OnContextClose,
  OnContextStart,
  QualifiedBean,
  RequestFacts,
  RequestScopeSeed,
} from "@/public-types";
// 请求事实的读取点（#380）：与请求作用域同一个 ALS，裸函数读取——想读 request id 的代码
// （logger 的 serializer、starter 里的工具函数）手上没有 context，逼它们先变成 bean 的约束
// 会传染。
export { currentRequestFacts, runWithRequestFacts } from "@/runtime/request-scope";
