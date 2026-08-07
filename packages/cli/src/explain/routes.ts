import { isObject } from "radashi";

// reforce explain 的 web 面（ADR 0006 W1，#153）：只读生成的 routes.json，静态回答
// "这个路径谁在处理、过哪些中间件、为什么是这个顺序"。与 bean 面同一输出契约：一行一个
// 事实、字段用 " · " 分隔。链在编译期按 (阶段, order, beanId) 压平写死，这里只转述表内容。

export interface RouteManifestMiddleware {
  readonly beanId: string;
  readonly phase: string;
  readonly order: number;
  readonly mount: string;
}

// 槽位契约节(RFC 0012 S2,#274):可选键拼错在运行时是静默的(解码器只认声明键),这里的
// 键名打印是唯一的排查入口,所以逐槽转述 slot/key/来源,不做汇总折叠。
export interface RouteManifestSlot {
  readonly slot: string;
  readonly key?: string;
  readonly form?: string;
  readonly source?: { readonly kind: string; readonly vendor?: string };
}

export interface RouteManifestContract {
  readonly slots: readonly RouteManifestSlot[];
  readonly response: string;
}

export interface RouteManifestEntry {
  readonly method: string;
  readonly path: string;
  readonly controller: { readonly beanId: string; readonly handler: string };
  readonly middleware: readonly RouteManifestMiddleware[];
  readonly meta: Readonly<Record<string, unknown>>;
  readonly contract: RouteManifestContract;
}

export interface RouteManifest {
  readonly routes: readonly RouteManifestEntry[];
  readonly errorHandlers: readonly { readonly beanId: string; readonly order: number }[];
}

function parsedMiddleware(value: unknown): RouteManifestMiddleware | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const beanId = Reflect.get(value, "beanId");
  const phase = Reflect.get(value, "phase");
  const order = Reflect.get(value, "order");
  const mount = Reflect.get(value, "mount");
  if (
    typeof beanId !== "string" ||
    typeof phase !== "string" ||
    typeof order !== "number" ||
    typeof mount !== "string"
  ) {
    return undefined;
  }
  return { beanId, phase, order, mount };
}

function parsedSlot(value: unknown): RouteManifestSlot | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const slot = Reflect.get(value, "slot");
  if (typeof slot !== "string") {
    return undefined;
  }
  const key = Reflect.get(value, "key");
  const form = Reflect.get(value, "form");
  const source = Reflect.get(value, "source");
  const sourceKind = isObject(source) ? Reflect.get(source, "source") : undefined;
  const vendor = isObject(source) ? Reflect.get(source, "vendor") : undefined;
  return {
    slot,
    ...(typeof key === "string" ? { key } : {}),
    ...(typeof form === "string" ? { form } : {}),
    ...(typeof sourceKind === "string"
      ? { source: { kind: sourceKind, ...(typeof vendor === "string" ? { vendor } : {}) } }
      : {}),
  };
}

function parsedContract(value: unknown): RouteManifestContract | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const slots = Reflect.get(value, "slots");
  const response = Reflect.get(value, "response");
  if (!Array.isArray(slots) || !isObject(response)) {
    return undefined;
  }
  const parsedSlots: RouteManifestSlot[] = [];
  for (const entry of slots) {
    const parsed = parsedSlot(entry);
    if (parsed === undefined) {
      return undefined;
    }
    parsedSlots.push(parsed);
  }
  const responseKind = Reflect.get(response, "kind");
  if (typeof responseKind !== "string") {
    return undefined;
  }
  return { slots: parsedSlots, response: responseKind };
}

function parsedRoute(value: unknown): RouteManifestEntry | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const method = Reflect.get(value, "method");
  const path = Reflect.get(value, "path");
  const controller = Reflect.get(value, "controller");
  const middleware = Reflect.get(value, "middleware");
  const meta = Reflect.get(value, "meta");
  if (typeof method !== "string" || typeof path !== "string" || !isObject(controller)) {
    return undefined;
  }
  const beanId = Reflect.get(controller, "beanId");
  const handler = Reflect.get(controller, "handler");
  if (typeof beanId !== "string" || typeof handler !== "string" || !Array.isArray(middleware)) {
    return undefined;
  }
  const chain: RouteManifestMiddleware[] = [];
  for (const entry of middleware) {
    const parsed = parsedMiddleware(entry);
    if (parsed === undefined) {
      return undefined;
    }
    chain.push(parsed);
  }
  const contract = parsedContract(Reflect.get(value, "contract"));
  if (contract === undefined) {
    return undefined;
  }
  return {
    method,
    path,
    controller: { beanId, handler },
    middleware: chain,
    meta: isObject(meta) ? (meta as Record<string, unknown>) : {}, // JSON 树，形状由生成器保证
    contract,
  };
}

export function parseRouteManifestBytes(bytes: Uint8Array): RouteManifest | undefined {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
  // 2 = 槽位路由表(RFC 0012 S2,#274),与生成器/运行时的版本门同步。
  if (!isObject(value) || Reflect.get(value, "schemaVersion") !== 2) {
    return undefined;
  }
  const routes = Reflect.get(value, "routes");
  const errorHandlers = Reflect.get(value, "errorHandlers");
  if (!Array.isArray(routes) || !Array.isArray(errorHandlers)) {
    return undefined;
  }
  const parsedRoutes: RouteManifestEntry[] = [];
  for (const route of routes) {
    const parsed = parsedRoute(route);
    if (parsed === undefined) {
      return undefined;
    }
    parsedRoutes.push(parsed);
  }
  const parsedHandlers: { beanId: string; order: number }[] = [];
  for (const handler of errorHandlers) {
    if (!isObject(handler)) {
      return undefined;
    }
    const beanId = Reflect.get(handler, "beanId");
    const order = Reflect.get(handler, "order");
    if (typeof beanId !== "string" || typeof order !== "number") {
      return undefined;
    }
    parsedHandlers.push({ beanId, order });
  }
  return { routes: parsedRoutes, errorHandlers: parsedHandlers };
}

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
    if (route.contract.response === "table") {
      lines.push("  response · whitelisted by the return type contract");
    }
    if (Object.keys(route.meta).length > 0) {
      lines.push(`  meta · ${JSON.stringify(route.meta)}`);
    }
  }
  if (manifest.errorHandlers.length > 0) {
    lines.push("error handlers (dispatch order)");
    manifest.errorHandlers.forEach((handler, index) => {
      lines.push(`  ${index + 1}. order ${handler.order} · ${handler.beanId}`);
    });
  }
  return lines;
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
  if (manifest.errorHandlers.length > 0) {
    lines.push("error handlers (dispatch order)");
    manifest.errorHandlers.forEach((handler, index) => {
      lines.push(`  ${index + 1}. order ${handler.order} · ${handler.beanId}`);
    });
  }
  return lines;
}
