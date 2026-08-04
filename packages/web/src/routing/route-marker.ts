import type { RouteMetaValue } from "@/routing/vocabulary";

// 类型化路由元数据（ADR 0006 W3，#142 / #152）：defineRouteMarker<T>(key) 定义标记，
// @Marker(value) 的字面量参数被编译器提取进路由表 meta，中间件经 c.meta(Marker) 按 T 读回。
// 对位淘汰的是 Nest SetMetadata+Reflector 的运行时反射与裸字符串 key。
export interface RouteMarker<T extends RouteMetaValue = RouteMetaValue> {
  readonly key: string;
  (value: T): (value: unknown, context: ClassMethodDecoratorContext) => void;
}

// 装饰器本体照 Injectable 纪律保持 no-op：编译器静态提取字面量参数，运行时不依赖装饰器
// 副作用。key 守卫服务未经编译的调用方（与 Qualifier 同理）。
export function defineRouteMarker<T extends RouteMetaValue>(key: string): RouteMarker<T> {
  if (typeof key !== "string" || key.length === 0) {
    throw new TypeError("defineRouteMarker key must be a non-empty string.");
  }
  const marker = (_value: T) => () => undefined;
  return Object.freeze(Object.assign(marker, { key }));
}
