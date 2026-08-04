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

export interface RouteManifestEntry {
  readonly method: string;
  readonly path: string;
  readonly controller: { readonly beanId: string; readonly handler: string };
  readonly middleware: readonly RouteManifestMiddleware[];
  readonly meta: Readonly<Record<string, unknown>>;
  readonly schemas: Readonly<Record<string, unknown>>;
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

function parsedRoute(value: unknown): RouteManifestEntry | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const method = Reflect.get(value, "method");
  const path = Reflect.get(value, "path");
  const controller = Reflect.get(value, "controller");
  const middleware = Reflect.get(value, "middleware");
  const meta = Reflect.get(value, "meta");
  const schemas = Reflect.get(value, "schemas");
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
  return {
    method,
    path,
    controller: { beanId, handler },
    middleware: chain,
    meta: isObject(meta) ? (meta as Record<string, unknown>) : {}, // JSON 树，形状由生成器保证
    schemas: isObject(schemas) ? (schemas as Record<string, unknown>) : {}, // 同上
  };
}

export function parseRouteManifestBytes(bytes: Uint8Array): RouteManifest | undefined {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
  if (!isObject(value) || Reflect.get(value, "schemaVersion") !== 1) {
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
    const schemaSlots = Object.keys(route.schemas);
    if (schemaSlots.length > 0) {
      lines.push(`  schemas · ${schemaSlots.join(", ")}`);
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
