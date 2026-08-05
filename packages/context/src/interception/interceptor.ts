import type { MethodMarker, MethodMetaValue } from "@/interception/method-marker";
import type { BeanClass } from "@/public-types";

// 拦截阶段闭集（ADR 0008 AM1，#202 定案 1）：数组顺序即链上顺序（外→内），独立于 web 的
// WebPhase 词汇（web 三相无 cache/transaction 语义）。阶段内按 order 升序，同序值按 beanId
// 决胜，编译期把每个方法的链压平写死进织入表，运行时零决策：
// - observability：前后两相观测（追踪/度量/日志），不改变业务语义，能看到全链含事务开闭；
// - admission：准入短路（鉴权/限流形态），先于一切昂贵工作；
// - cache：命中即短路；必须在事务外——命中则根本不开事务；
// - transaction：资源边界（AM2 事务拦截器唯一落位）；
// - application：默认相，业务增强，运行在事务内。
export const interceptPhases = [
  "observability",
  "admission",
  "cache",
  "transaction",
  "application",
] as const;

export type InterceptPhase = (typeof interceptPhases)[number];

export function isInterceptPhase(value: unknown): value is InterceptPhase {
  return typeof value === "string" && (interceptPhases as readonly string[]).includes(value);
}

// 拦截器可见面封闭为四个字段（#202 定案 2）：显式不给实例（this/target 是容器后门）、
// 容器、改 args（冻结）与动态链操作；能力扩展每项走 RFC 增量。
export interface MethodInvocationContext<
  T extends MethodMetaValue | undefined = MethodMetaValue | undefined,
> {
  readonly beanId: string;
  readonly method: string;
  readonly args: readonly unknown[];
  // 本拦截器所绑标记在被织方法上的字面量参数；0 参调用时为 undefined。
  readonly value: T;
}

// 方法拦截洋葱契约：await next() 前后两相、不调 next() 即短路、return 别的值即替换返回值、
// try/catch next() 即捕获/转换异常。方法名取 intercept 而非 web 的 handle——两契约签名不同，
// 异名避免一个 bean 静默同时满足两个鸭子检查（#202 定案 2）。
export interface MethodInterceptor<
  T extends MethodMetaValue | undefined = MethodMetaValue | undefined,
> {
  intercept(context: MethodInvocationContext<T>, next: () => Promise<unknown>): Promise<unknown>;
}

export interface InterceptorOptions<T extends MethodMetaValue | undefined> {
  // 绑定的标记引用：编译器经声明解析落到 defineMethodMarker 注册表，运行时只做形状守卫。
  readonly marker: MethodMarker<T>;
  // 缺省 application 阶段、序值 0。
  readonly phase?: InterceptPhase;
  readonly order?: number;
}

// 与 @Middleware 同款纪律（ADR 0008 AM1）：编译期静态读取、运行时 no-op、标准 TC39 装饰器。
// 拦截器是普通 bean——bean 身份仍由 @Injectable() 声明，这里只补充织入语义。参数守卫服务
// 未经编译的调用方（与 Qualifier 同理）。
export function Interceptor<T extends MethodMetaValue | undefined>(
  options: InterceptorOptions<T>,
): <C extends BeanClass>(value: C, context: ClassDecoratorContext<C>) => void {
  if (options === null || typeof options !== "object") {
    throw new TypeError("Interceptor options must be an object.");
  }
  const marker: unknown = options.marker;
  if (typeof marker !== "function" || typeof Reflect.get(marker, "key") !== "string") {
    throw new TypeError(
      "Interceptor marker must be a method marker created by defineMethodMarker().",
    );
  }
  if (options.phase !== undefined && !isInterceptPhase(options.phase)) {
    throw new TypeError(
      'Interceptor phase must be "observability", "admission", "cache", "transaction", or "application".',
    );
  }
  if (
    options.order !== undefined &&
    (typeof options.order !== "number" || !Number.isInteger(options.order))
  ) {
    throw new TypeError("Interceptor order must be an integer when provided.");
  }
  return () => undefined;
}
