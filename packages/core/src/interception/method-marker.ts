import {
  describeValue,
  InvalidMethodMarkerKeyError,
  MethodMarkerArityError,
  MethodMarkerTargetError,
} from "@/argument-errors";
// 方法级标记（ADR 0008 AM1，#202）：defineMethodMarker<T>(key) 定义标记，@Marker(value)
// 的字面量参数被编译器提取进织入表，拦截器经 ctx.value 按 T 读回。标记本身是元数据，
// 行为来自 @Interceptor 绑定的拦截器。

// JSON 字面量树：编译器只提取静态字面量形态，织入表因此可稳定序列化、可 diff。与 web 的
// RouteMetaValue 同构但不复用——web 依赖 context，不反向引入依赖；Rule of Three 第二次
// 出现，保持重复（#202 定案 2）。
export type MethodMetaValue =
  | string
  | number
  | boolean
  | null
  | readonly MethodMetaValue[]
  | { readonly [key: string]: MethodMetaValue };

// T 含 undefined 时允许 0 参裸调用（AM2 @Transactional() 的核心人体工学，#202 定案）；
// 否则恰好 1 个字面量参数。条件元组在类型层钉死 0/1 参，运行时守卫兜住未经编译的调用方。
export interface MethodMarker<T extends MethodMetaValue | undefined = undefined> {
  readonly key: string;
  (
    ...args: undefined extends T ? [] | [value: T] : [value: T]
  ): (value: unknown, context: ClassMethodDecoratorContext) => void;
}

// 装饰器本体照 Injectable 纪律保持 no-op：编译器静态提取字面量参数，运行时不依赖装饰器
// 副作用。key / 参数个数 / 装饰位置守卫服务未经编译的调用方（与 Qualifier 同理）；类位置
// 在类型层已被 ClassMethodDecoratorContext 拒绝，这里是双保险（#202 定案 3）。
export function defineMethodMarker<T extends MethodMetaValue | undefined = undefined>(
  key: string,
): MethodMarker<T> {
  if (typeof key !== "string" || key.length === 0) {
    throw new InvalidMethodMarkerKeyError([describeValue(key)]);
  }
  const marker = (...args: readonly unknown[]) => {
    if (args.length > 1) {
      throw new MethodMarkerArityError([key]);
    }
    return (_value: unknown, context: ClassMethodDecoratorContext | ClassDecoratorContext) => {
      if (context.kind !== "method") {
        throw new MethodMarkerTargetError([key]);
      }
    };
  };
  // MethodMarker<T> 的调用签名是未实例化 T 上的条件元组，只有调用点实例化后才可判定，
  // 实现签名无法被结构性证明满足它；宽签名在运行时不可区分 // justified: 见上
  return Object.freeze(Object.assign(marker, { key })) as MethodMarker<T>;
}
