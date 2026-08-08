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

// 按 marker 读 meta 的唯一实现（#232）。两个消费方共用它：RequestContext.meta（每请求，中间件与
// handler 用）与 PreparedRoute.meta（启动期，引擎的 route customizer 用）。共用的实际收益是
// 下面那条 `as` 只需要在一处论证，也让两侧的调用写法完全一致——customizer 作者不用学两套。
export function metaLookup(
  meta: Readonly<Record<string, RouteMetaValue>>,
): <T extends RouteMetaValue>(marker: RouteMarker<T>) => T | undefined {
  return <T extends RouteMetaValue>(marker: RouteMarker<T>) =>
    // 表里的值由编译器从 @Marker(value: T) 的字面量参数提取而来，T 在声明处即被钉死，
    // 运行时序列化形态推不回字面量类型 // justified: 见上一行
    meta[marker.key] as T | undefined;
}
