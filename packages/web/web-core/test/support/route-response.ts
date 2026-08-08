import { type RouteResponse, readRouteBody } from "@/execution/route-response";

// 读体的实现是公开 API（`readRouteBody`），这里只补一个 JSON 便利包装给断言用。
// 不再维护第二份读取逻辑——两份迟早漂移，而漂移的那一份会让测试在真实行为已经改掉之后
// 仍然通过。
export { readRouteBody };

export async function readRouteJson(response: RouteResponse): Promise<unknown> {
  return JSON.parse(await readRouteBody(response));
}
