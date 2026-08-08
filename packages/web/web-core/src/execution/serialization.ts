import { ResponseSerializationError } from "@/errors";
import { absorbResponse, type RouteResponse } from "@/execution/route-response";
import type { GeneratedRouteResponse } from "@/generated/route-table";

// 响应序列化(ADR 0006 W5 → RFC 0012 S2 → S3 收口,#274/#275;#340 改产出内部货币):响应声明
// 来自返回类型/@ResponseSchema/推导,编译器据它生成白名单投影编码器与状态码,运行时按三变体分派。
// bigint 一律序列化为 JSON 字符串(雪花 ID 语义,JSON.stringify 原生对 bigint 抛 TypeError)。

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

// 传 replacer 会让引擎退出内置序列化快速路径、改为逐 key 回调：Bun 1.3.14/darwin-arm64 实测
// 无 bigint 的常规响应上慢 4.3 倍（12.1M → 2.84M ops/s）。绝大多数响应不含 bigint，所以先走
// 无 replacer 的快路径，真撞上 bigint 才带 replacer 重来一次（Issue #198）。循环引用抛的同样是
// TypeError，重试会再抛一次并原样上抛，对外行为与只走 replacer 路径时一致。
function renderJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch (cause) {
    if (!(cause instanceof TypeError)) {
      throw cause;
    }
    return JSON.stringify(value, bigintReplacer);
  }
}

const encoder = new TextEncoder();

// 头直接写进传入的那一个 Headers（#340 决议 2：响应头单一通道，就是 context.responseHeaders）。
// 不新建、不返回第二份，因此没有「两份头需要合并」这件事——mergeResponseHeaders 已删除。
//
// 长度必须是**字节数**而不是字符数：JSON.stringify 不转义非 ASCII，"汉字" 是 2 char / 6 byte。
// 先编码再把字节交出去，而不是编码一次只为量长度。
// error-dispatch 的兜底/编码响应共用同一出口:JSON 响应的头与长度语义只此一份。
export function jsonResponse(status: number, value: unknown, headers: Headers): RouteResponse {
  const rendered = renderJson(value);
  if (rendered === undefined) {
    throw new ResponseSerializationError("the handler return value is not JSON-serializable.");
  }
  const bytes = encoder.encode(rendered);
  headers.set("content-type", "application/json");
  headers.set("content-length", String(bytes.byteLength));
  return { status, headers, body: bytes };
}

export type ResponseEncoder = (value: unknown) => unknown;

// 三变体分派(RFC 0012 S3,#275)。handler 返回 Response 在任何 kind 下都是逃生口
// (#264 决策 7):框架原样透传,不投影、不盖状态码——#340 之后「透传」的实现是**吸收**
// (读它的 status/headers,body 连引用搬走、绝不消费),语义不变。
// - table:白名单投影编码器先行,bigint/Date 已在编码产物里归一成串;
// - free-form:无契约声明且推导失败的降级——返回值原样序列化(bigint 走 replacer 重试、
//   Date 走 toJSON、NaN/Infinity 落 null),不投影不白名单;
// - passthrough:undefined ⇒ 空体(status 缺省 204,void 路由的真空响应);其余非 Response
//   值抛 ResponseSerializationError(500 语义不变)。
export function serializeResponse(
  value: unknown,
  response: GeneratedRouteResponse,
  headers: Headers,
): RouteResponse {
  if (value instanceof Response) {
    return absorbResponse(value, headers);
  }
  if (response.kind === "table") {
    return jsonResponse(response.status, response.encode(value), headers);
  }
  if (response.kind === "free-form") {
    return jsonResponse(response.status, value, headers);
  }
  if (value === undefined) {
    // 204/304 依 RFC 9110 不得带 content-length，空体天然不写它。
    return { status: response.status ?? 204, headers, body: null };
  }
  throw new ResponseSerializationError(
    "the route passes responses through, so the handler must return a Response or nothing.",
  );
}
