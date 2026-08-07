import type {
  RouteManifest,
  RouteManifestEntry,
  RouteManifestErrorHandler,
  RouteManifestResponse,
  RouteManifestSlot,
  RouteManifestThrownError,
} from "@/project/route-manifest";

// reforce explain 的 web 面（ADR 0006 W1，#153）：只读生成的 routes.json，静态回答
// "这个路径谁在处理、过哪些中间件、为什么是这个顺序"。与 bean 面同一输出契约：一行一个
// 事实、字段用 " · " 分隔。链在编译期按 (阶段, order, beanId) 压平写死，这里只转述表内容。
// 解析器在 project/route-manifest.ts（与 `reforce openapi` 共用，#306）；explain 只消费
// 概要面，字段表 table 在渲染里不出现。

export interface RouteQuery {
  readonly method?: string;
  readonly path: string;
}

// 查询形态：`/users/:id`（全部方法）或 `GET /users/42`（方法过滤）。路径既可给路由模式本身，
// 也可给具体路径——具体路径按段匹配模式（:param 通配一段）。
export function parseRouteQuery(query: string): RouteQuery | undefined {
  const parts = query.trim().split(/\s+/);
  if (parts.length === 1) {
    return parts[0]?.startsWith("/") ? { path: parts[0] } : undefined;
  }
  if (parts.length !== 2) {
    return undefined;
  }
  const [method, path] = parts;
  if (method === undefined || path === undefined || !path.startsWith("/")) {
    return undefined;
  }
  return { method: method.toUpperCase(), path };
}

export function isRouteQuery(query: string): boolean {
  return parseRouteQuery(query) !== undefined;
}

function segments(path: string): readonly string[] {
  return path.split("/").filter((segment) => segment !== "");
}

function pathMatches(pattern: string, queryPath: string): boolean {
  if (pattern === queryPath) {
    return true;
  }
  const patternSegments = segments(pattern);
  const querySegments = segments(queryPath);
  if (patternSegments.length !== querySegments.length) {
    return false;
  }
  return patternSegments.every(
    (expected, index) => expected.startsWith(":") || expected === querySegments[index],
  );
}

export function matchRoutes(
  manifest: RouteManifest,
  query: RouteQuery,
): readonly RouteManifestEntry[] {
  return manifest.routes.filter(
    (route) =>
      pathMatches(route.path, query.path) &&
      (query.method === undefined || route.method === query.method),
  );
}

// 键名是这行的主角:Query<"pgae"> 这类 typo 在运行时静默(解码器只监听声明键),这里把每个
// 参数实际监听的键与契约来源(type / schema+vendor)如实印出来。
function slotLine(slot: RouteManifestSlot): string {
  const parts = [slot.slot];
  if (slot.key !== undefined) {
    parts.push(`key ${slot.key}`);
  }
  if (slot.form === "optional-single") {
    parts.push("optional");
  }
  if (slot.source?.kind === "type") {
    parts.push("decoded from the type");
  } else if (slot.source?.kind === "schema") {
    parts.push(
      slot.source.vendor === undefined
        ? "decoded by schema"
        : `decoded by schema (${slot.source.vendor})`,
    );
  }
  return parts.join(" · ");
}

export function renderRouteExplanation(
  manifest: RouteManifest,
  matches: readonly RouteManifestEntry[],
): readonly string[] {
  const lines: string[] = [];
  for (const route of matches) {
    lines.push(`${route.method} ${route.path}`);
    lines.push(`  handler ${route.controller.beanId} · ${route.controller.handler}()`);
    if (route.middleware.length === 0) {
      lines.push("  middleware chain · (empty)");
    } else {
      lines.push(
        "  middleware chain (outer → inner) · flattened at compile time by (phase, order, beanId)",
      );
      route.middleware.forEach((middleware, index) => {
        lines.push(
          `  ${index + 1}. ${middleware.phase} · order ${middleware.order} · ${middleware.mount} · ${middleware.beanId}`,
        );
      });
    }
    if (route.contract.slots.length > 0) {
      lines.push("  inputs (handler parameter order)");
      route.contract.slots.forEach((slot, index) => {
        lines.push(`  ${index + 1}. ${slotLine(slot)}`);
      });
    }
    lines.push(`  ${responseLine(route.contract.response)}`);
    for (const thrown of route.contract.response.errors) {
      lines.push(`  ${thrownErrorLine(thrown)}`);
    }
    if (Object.keys(route.meta).length > 0) {
      lines.push(`  meta · ${JSON.stringify(route.meta)}`);
    }
  }
  lines.push(...errorHandlerLines(manifest));
  return lines;
}

// 响应三变体各一行(S3,#275):table/free-form 的差别是「有没有白名单」——free-form 是
// 降级形态,序列化原样出线,这行是唯一提醒读者补返回类型标注的出口。
function responseLine(response: RouteManifestResponse): string {
  if (response.kind === "table") {
    return `response · ${String(response.status ?? 200)} · whitelisted by the return type contract`;
  }
  if (response.kind === "free-form") {
    return `response · ${String(response.status ?? 200)} · free-form (serialized as-is, no whitelist)`;
  }
  if (response.status !== undefined) {
    return `response · passthrough (handler-controlled Response; void answers ${String(response.status)})`;
  }
  return "response · passthrough (handler-controlled Response; void answers 204)";
}

// handler 缺席 = defineHttpError 造的异常(#310):没有处理器 bean,运行时兜底闭集直译
// problem+json,这行要让读者看出「不用注册处理器」而不是「处理器丢了」。
function thrownErrorLine(thrown: RouteManifestThrownError): string {
  const status = thrown.status === undefined ? "" : ` → ${String(thrown.status)}`;
  const via = thrown.handler ?? "built-in problem+json (defineHttpError)";
  return `throws ${thrown.error}${status} · ${via}`;
}

function errorHandlerLine(handler: RouteManifestErrorHandler, index: number): string {
  const accepts = handler.accepts === undefined ? "match-all" : `accepts ${handler.accepts.name}`;
  const status = handler.status === undefined ? "" : ` · ${String(handler.status)}`;
  return `  ${index + 1}. order ${handler.order} · ${handler.beanId} · ${accepts}${status}`;
}

function errorHandlerLines(manifest: RouteManifest): readonly string[] {
  if (manifest.errorHandlers.length === 0) {
    return [];
  }
  return [
    "error handlers (dispatch order)",
    ...manifest.errorHandlers.map((handler, index) => errorHandlerLine(handler, index)),
  ];
}

export function knownRouteList(manifest: RouteManifest): string {
  return manifest.routes.map((route) => `${route.method} ${route.path}`).join(", ");
}

// `reforce explain routes` 的全量列表（RFC 0011 D2，#242）。
//
// 这条命令此前**不存在**：路由面的判据是「查询以 / 开头」，`routes` 这个词会落到 bean 面然后
// 报「没有 bean 叫 routes」。而启动摘要把这个字面量印给了用户（`37 routes — reforce explain
// routes`），于是折叠给了出口、出口是死的——那比不给出口更糟，读者会以为自己敲错了。
// 不变量 4 要的是「计数 + **可用**的展开路径」，两者缺一不可。
//
// 每条路由的中间件在这里仍是计数（37 条路由各展开一遍链就又变成刷屏了），所以顶部单独给一行
// 下一级出口，而不是每行重复一遍。
export function renderRouteOverview(manifest: RouteManifest): readonly string[] {
  if (manifest.routes.length === 0) {
    return ["0 routes"];
  }
  const controllers = new Set(manifest.routes.map((route) => route.controller.beanId));
  const lines = [
    `${manifest.routes.length} routes · ${controllers.size} controllers`,
    `expand one route · reforce explain "<METHOD> <path>"`,
  ];
  for (const route of manifest.routes) {
    const chain =
      route.middleware.length === 0 ? "no middleware" : `${route.middleware.length} middleware`;
    lines.push(
      `${route.method} ${route.path} · ${route.controller.beanId} · ${route.controller.handler}() · ${chain}`,
    );
  }
  lines.push(...errorHandlerLines(manifest));
  return lines;
}
