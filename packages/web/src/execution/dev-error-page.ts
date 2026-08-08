import { randomUUID } from "node:crypto";
import { STATUS_CODES } from "node:http";
import { isObject } from "radashi";
import { Youch } from "youch";
import type { ErrorMetadataRow } from "youch/types";
import type { ProblemDescription } from "@/execution/error-dispatch";
import type { RequestContext } from "@/execution/request-context";
import { currentRequestId } from "@/execution/request-fields";

// dev 错误页渲染器（#279）：youch 的封装层。本模块只在 dev 链路被加载——生产构建里它被
// CLI 替换成空 stub（cli/production-dist），错误分派侧还有 NODE_ENV 折叠与旗标两层门。
//
// youch 模板的转义面经过逐处核对（youch@4.1.1 锁 exact，升级须人工重审模板）：
// - message/name/title：htmlEscape，安全；
// - hint（parser 自动取 error.hint ?? error.help）：**原样 raw HTML**，必须封死（防线 1）；
// - metadata 的 group/section/key：**不转义**，只能放编译期字面量（防线 2）；
// - metadata 的值位：字符串走 htmlEscape、对象走 @poppinss/dumper（键值均转义），安全；
// - 内置 request.headers 口子会把 header 名展开成 rows 的 key——header 名攻击者可控，
//   等于把可控字符串送进不转义槽位，因此 headers 绝不走内置口子，见 maskedHeaders。

const encoder = new TextEncoder();

// 凭证头打码（#279 防线 4）：值遮蔽、留键名与长度——排查「带没带 Authorization、长度对不对」
// 够用，而页面截图/复制不再泄凭证。Headers 迭代产出小写键名，集合按小写匹配。
const maskedHeaderNames = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-api-key",
]);

function maskedHeaders(headers: Headers): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const [name, value] of headers) {
    snapshot[name] = maskedHeaderNames.has(name) ? `«redacted, ${value.length} chars»` : value;
  }
  return snapshot;
}

function describeThrownValue(value: unknown): string {
  try {
    return `${Object.prototype.toString.call(value)} ${String(value)}`;
  } catch {
    // String() 会触发用户对象的 toString，它可以抛；标签部分不经用户代码，保底可用。
    return Object.prototype.toString.call(value);
  }
}

// 源码加载防线（#279）：youch-core 按栈帧的 fileName readFile 展示源码框。伪造的
// {message, stack} 普通对象能把任意路径塞进 fileName；非 Error 值一律换成这里新建的 Error，
// 栈真实指向框架自身，fs 读取范围不受抛出值控制。
function renderableError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(`The route threw a non-Error value: ${describeThrownValue(error)}`);
}

// 诊断行（值位全部经模板转义，见文件头的转义面核对）：code 存在时无条件带
// `reforce explain <code>` 命令串——explain 对没有长文的码有优雅回答，web 不依赖 CLI 的
// 长文表；help 走这里的值位而不是 parser 的 hint 通道（防线 1 的替代出口）。
function diagnosisRows(error: unknown, problem: ProblemDescription): ErrorMetadataRow[] {
  const rows: ErrorMetadataRow[] = [];
  const code = problem.members.code;
  if (typeof code === "string") {
    rows.push({ key: "Code", value: code });
    rows.push({ key: "Explain", value: `reforce explain ${code}` });
  }
  const help = isObject(error) ? Reflect.get(error, "help") : undefined;
  if (typeof help === "string") {
    rows.push({ key: "Help", value: help });
  }
  const errorId = problem.members.errorId;
  if (typeof errorId === "string") {
    rows.push({ key: "Error ID", value: errorId });
  }
  const issues = problem.members.issues;
  if (Array.isArray(issues)) {
    rows.push({ key: "Issues", value: issues });
  }
  return rows;
}

export interface RenderDevErrorPageInput {
  readonly error: unknown;
  readonly context: RequestContext;
  readonly problem: ProblemDescription;
}

export async function renderDevErrorPage(input: RenderDevErrorPageInput): Promise<Response> {
  const { context, problem } = input;
  // 每错误一个新实例（#279 防线 5）：Metadata 是实例态、group() 是合并语义，复用实例会把
  // 上一请求的 headers/params 带进下一页。
  const youch = new Youch();
  // 防线 1：封死 hint 通道。parser 自动把 error.hint ?? error.help 提为 hint，而模板对
  // hint **不转义**（上游为了让官方错误带格式化指引）。parse 后抹掉，help 改走上面
  // diagnosisRows 的值位。
  youch.useTransformer((parsed) => {
    Reflect.deleteProperty(parsed, "hint");
  });
  const error = renderableError(input.error);
  const requestId = currentRequestId();
  // 防线 2：攻击者可控字符串只进 metadata 的**值位**。group/section/key 一律编译期字面量；
  // headers 整体作为单对象值交 dumper（键值均转义），不展开成 rows。
  youch.metadata.group("Request", {
    headers: { key: "Headers", value: maskedHeaders(context.request.headers) },
  });
  youch.metadata.group("Reforce", {
    route: [
      { key: "Pattern", value: context.path },
      { key: "Params", value: { ...context.params } },
      ...(requestId === undefined ? [] : [{ key: "Request ID", value: requestId }]),
    ],
    diagnosis: diagnosisRows(input.error, problem),
  });
  // 防线 3：每响应新 nonce 的严格 CSP。randomUUID 的字符集是 CSP nonce 合法子集。
  // 编辑器跳转沿 youch 原生 ide 机制（process.env.IDE，默认 vscode），不在这里传参。
  const nonce = randomUUID();
  const html = await youch.toHTML(error, {
    title: STATUS_CODES[problem.status] ?? "Error",
    cspNonce: nonce,
    request: { url: context.url.href, method: context.method },
  });
  const bytes = encoder.encode(html);
  return new Response(bytes, {
    status: problem.status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // content-length：对称 jsonResponse/problemResponse——适配器据它选 Buffer / 流路径
      // （见 adapter.ts 的契约块）。
      "content-length": String(bytes.byteLength),
      // nonce 放行 youch 自带的内联 style/script，其余全关。已知代价：模板里复制按钮的
      // inline onclick 会被浏览器拦，安全边界优先于这颗按钮。
      "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'`,
      "x-content-type-options": "nosniff",
      // 错误页随代码热更而变，任何缓存都是误导；Vary 对齐 wantsHtml 按 Accept 分叉的事实。
      "cache-control": "no-store",
      vary: "accept",
    },
  });
}
