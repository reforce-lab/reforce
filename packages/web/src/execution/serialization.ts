import { ResponseSerializationError } from "@/errors";

// 响应序列化(ADR 0006 W5 → RFC 0012 S2 重铸,#274):响应契约来自返回类型标注,编译器据它
// 生成白名单投影编码器(GeneratedRoute.encode),运行时只负责"编码产物 → JSON Response"。
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

// content-length 是适配器的缓冲/流式判据（#232，见 adapter.ts 的契约块）：带它即"整体已在内存中"，
// 引擎可以走 Buffer 路径把 etag / 压缩这类需要完整体的能力打开。new Response(str) 不会自动
// 带这个头，所以显式设是有意义的。
//
// 长度必须是**字节数**而不是字符数：JSON.stringify 不转义非 ASCII，"汉字" 是 2 char / 6 byte。
// 这里先编码再把字节交给 Response，而不是编码一次只为量长度——Response 内部本来也要编码，
// 这样反而少一趟。
function jsonResponse(value: unknown): Response {
  const rendered = renderJson(value);
  if (rendered === undefined) {
    throw new ResponseSerializationError("the handler return value is not JSON-serializable.");
  }
  const bytes = encoder.encode(rendered);
  return new Response(bytes, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "content-length": String(bytes.byteLength),
    },
  });
}

export type ResponseEncoder = (value: unknown) => unknown;

// handler 返回 Response 是逃生口(#264 决策 7):框架原样透传,不投影、不加头。
// 无编码器 = 路由没有返回类型标注:S2 中间态下 handler 必须自己返回 Response,普通对象
// 500;"无标注 → 编译期硬错"归 S3,届时这个分支只剩逃生口透传。
export function serializeResponse(value: unknown, encode: ResponseEncoder | undefined): Response {
  if (value instanceof Response) {
    return value;
  }
  if (encode === undefined) {
    throw new ResponseSerializationError(
      "the route declares no response contract, so the handler must return a Response.",
    );
  }
  return jsonResponse(encode(value));
}
