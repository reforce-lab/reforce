import {
  describeValue,
  InvalidInterceptorMarkerError,
  InvalidInterceptorOptionsError,
  InvalidInterceptorOrderError,
  InvalidInterceptorPhaseError,
} from "@/argument-errors";
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
//
// 契约分两个接口而非一个 Promise<unknown>：返回类型在类型层强制，织入链上不可能出现"某层
// 悄悄把返回值换成别的形状"（#202 风险 1 的第二轮收紧）。
//
// 透传型：R 是 intercept 自己的方法级类型参数，拦截器拿到的是"某个它不知道的类型"，唯一
// 造得出 Promise<R> 的途径就是把 next() 的结果原样返回——「observability / transaction 阶段
// 不改变业务语义」由此从注释变成类型强制。它可以挂任意返回类型的方法。
//
// 已知能力收窄：透传型可以 catch 后 rethrow（异常转换仍在），但造不出 R，因此无法 catch 后
// 返回兜底值。通用降级拦截器必须用替换型并绑定具体返回类型。
//
// next() 每层至多调一次，重入抛 InterceptorReenteredError。这是 v1 定案（#202 定案 2）而不是
// 没做完：next() 返回时外层的后置相与事务边界都已经结束了，第二次进去等于在一个已提交或已
// 回滚的边界里重跑——重试要在调用点做，那里每次调用开一条新链、一个新事务。
//
// 兜底型拦截器（catch 住一切、返回降级值的那种）必须放行框架护栏：
//
//   try { return await next() } catch (error) {
//     if (isReforceError(error)) { throw error }
//     return fallback
//   }
//
// 少这一行，框架告诉你"你的 manager 有问题"的四个事务护栏错误与上面的重入错误会被自己的
// 兜底吞掉，现象是"没报错但数据不对"。业务异常照常降级，不受影响。
//
// 用 isReforceError 而不是 instanceof ReforceError（ADR 0013 决议 1，#280）：谱系统一后这一句
// 同时覆盖 core / transaction / web / cli 四棵子树，而形状守卫在 @reforce/core 被装成两份物理
// 拷贝时仍然成立——instanceof 那时会把另一份拷贝抛出的护栏错误判否，正是这条纪律最怕的失效。
export interface MethodInterceptor<
  T extends MethodMetaValue | undefined = MethodMetaValue | undefined,
> {
  intercept<R>(context: MethodInvocationContext<T>, next: () => Promise<R>): Promise<R>;
}

// 替换型：R 提到接口上，同时处于协变（返回）与逆变（next 的返回）位 → invariant，只能挂
// 返回类型精确匹配的方法。要替换返回值就必须声明替换成什么——原本被 Promise<unknown>
// 掩盖的"这个拦截器到底能挂在哪些方法上"因此显形。
export interface ReplacingMethodInterceptor<T extends MethodMetaValue | undefined, R> {
  intercept(context: MethodInvocationContext<T>, next: () => Promise<R>): Promise<R>;
}

// 字段形态的 intercept 类型（与 web 的 MiddlewareHandle 同款用途，#222）：TS 只在上下文类型
// 位置（类字段 + 箭头函数）给参数做上下文类型化，方法参数无论 implements、抽象基类、带实现的
// 基类还是装饰器签名都拿不到（实测 tsgo 7.0.2 四种形态全部 TS7006）。没有它，用户要把
// MethodInvocationContext<{ label: string }> 这种长类型手抄一遍。方法形态仍是文档默认，两种
// 写法运行时等价——invokeIntercepted 用属性访问，字段同样命中。
export type InterceptHandle<T extends MethodMetaValue | undefined> = <R>(
  context: MethodInvocationContext<T>,
  next: () => Promise<R>,
) => Promise<R>;

export type ReplacingInterceptHandle<T extends MethodMetaValue | undefined, R> = (
  context: MethodInvocationContext<T>,
  next: () => Promise<R>,
) => Promise<R>;

export interface InterceptorOptions<T extends MethodMetaValue | undefined> {
  // 绑定的标记引用：编译器经声明解析落到 defineMethodMarker 注册表，运行时只做形状守卫。
  readonly marker: MethodMarker<T>;
  // 缺省 application 阶段、序值 0。
  readonly phase?: InterceptPhase;
  readonly order?: number;
}

// 两种拦截器形态的共同上界：只钉 ctx 的 T——marker 声明的值类型必须与拦截器读回的类型对上，
// 否则要到运行时读 ctx.value 才炸。不钉 R：链上返回类型的一致性由生成物组装时的
// GeneratedMethodChain<R> 背书，在装饰器上重复检查只会把两种合法形态挡在门外。next 取 never
// 让方法参数双变把两种形态都接住（透传型的 () => Promise<R> 与替换型的 () => Promise<R>）。
interface InterceptorLike<T extends MethodMetaValue | undefined> {
  intercept(context: MethodInvocationContext<T>, next: never): Promise<unknown>;
}

// 与 @Middleware 同款纪律（ADR 0008 AM1）：编译期静态读取、运行时 no-op、标准 TC39 装饰器。
// 装饰器钉死自身契约（#222 在 web 侧确立、这里补齐）：只标记 intercept 形状对得上的类，
// 拼错方法名或 marker 值类型对不上都在 typecheck 就红。角色装饰器蕴含 bean 身份（#221），
// 不需要并列 @Injectable()。参数守卫服务未经编译的调用方（与 Qualifier 同理）。
export function Interceptor<T extends MethodMetaValue | undefined>(
  options: InterceptorOptions<T>,
): <C extends BeanClass<InterceptorLike<T>>>(value: C, context: ClassDecoratorContext<C>) => void {
  if (options === null || typeof options !== "object") {
    throw new InvalidInterceptorOptionsError([describeValue(options)]);
  }
  const marker: unknown = options.marker;
  if (typeof marker !== "function" || typeof Reflect.get(marker, "key") !== "string") {
    throw new InvalidInterceptorMarkerError([]);
  }
  if (options.phase !== undefined && !isInterceptPhase(options.phase)) {
    throw new InvalidInterceptorPhaseError([describeValue(options.phase)]);
  }
  if (
    options.order !== undefined &&
    (typeof options.order !== "number" || !Number.isInteger(options.order))
  ) {
    throw new InvalidInterceptorOrderError([describeValue(options.order)]);
  }
  return () => undefined;
}
