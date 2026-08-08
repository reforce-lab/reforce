import { isObject } from "radashi";
import { InvalidRouteTableError } from "@/errors";
import type { GeneratedRouteTable } from "@/generated/route-table";
import { isHttpMethod, isWebPhase } from "@/routing/vocabulary";

// 路由表按 GeneratedApplicationDefinition 的同一纪律在消费时逐字段复检（公开签名类型化，
// 运行时仍按不可信输入处理）：顶层键封闭、词汇闭集拒绝未知值、schemaVersion 是硬版本门。

const middlewareMounts = new Set(["controller", "global", "route"]);

function fail(detail: string): never {
  throw new InvalidRouteTableError(detail);
}

function requireObject(value: unknown, path: string): object {
  if (!isObject(value)) {
    return fail(`${path} must be an object.`);
  }
  return value;
}

function requireExactKeys(value: object, allowed: readonly string[], path: string): void {
  const allowedKeys = new Set<PropertyKey>(allowed);
  for (const key of Reflect.ownKeys(value)) {
    if (!allowedKeys.has(key)) {
      fail(`${path} contains unknown field "${String(key)}".`);
    }
  }
}

function requireArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    return fail(`${path} must be an array.`);
  }
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    return fail(`${path} must be a string.`);
  }
  return value;
}

function requireFunction(value: unknown, path: string): void {
  if (typeof value !== "function") {
    fail(`${path} must be a function.`);
  }
}

function requireInteger(value: unknown, path: string): void {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    fail(`${path} must be an integer.`);
  }
}

function validateBeanId(value: unknown, path: string): void {
  const id = requireString(value, path);
  if (id.length === 0) {
    fail(`${path} must not be empty.`);
  }
}

function validateMetaValue(value: unknown, path: string): void {
  if (value === null) {
    return;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail(`${path} must be a finite number.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, element] of value.entries()) {
      validateMetaValue(element, `${path}[${index}]`);
    }
    return;
  }
  if (isObject(value)) {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        fail(`${path} keys must be strings.`);
      }
      validateMetaValue(Reflect.get(value, key), `${path}.${key}`);
    }
    return;
  }
  fail(`${path} must be a JSON value.`);
}

function validateMeta(value: unknown, path: string): void {
  const meta = requireObject(value, path);
  for (const key of Reflect.ownKeys(meta)) {
    if (typeof key !== "string") {
      fail(`${path} keys must be strings.`);
    }
    validateMetaValue(Reflect.get(meta, key), `${path}.${key}`);
  }
}

function validateStandardSchema(value: unknown, path: string): void {
  const schema = requireObject(value, path);
  const standard = Reflect.get(schema, "~standard");
  if (!isObject(standard) || typeof Reflect.get(standard, "validate") !== "function") {
    fail(`${path} must be a Standard Schema (missing ~standard.validate).`);
  }
}

// 槽位闭集(RFC 0012 S2,#274),与 GeneratedSlotKind 同步。
const slotKinds = new Set([
  "param",
  "query",
  "header",
  "body",
  "request",
  "requestContext",
  "responseHeaders",
]);

function validateSlot(value: unknown, path: string): void {
  const slot = requireObject(value, path);
  requireExactKeys(slot, ["slot", "key", "decode", "schema"], path);
  if (!slotKinds.has(String(Reflect.get(slot, "slot")))) {
    fail(`${path}.slot must be a supported slot kind.`);
  }
  const key = Reflect.get(slot, "key");
  if (key !== undefined && typeof key !== "string") {
    fail(`${path}.key must be a string when provided.`);
  }
  const decode = Reflect.get(slot, "decode");
  const schema = Reflect.get(slot, "schema");
  if (decode !== undefined && schema !== undefined) {
    fail(`${path} must not declare both decode and schema.`);
  }
  if (decode !== undefined) {
    validateStandardSchema(decode, `${path}.decode`);
  }
  if (schema !== undefined) {
    validateStandardSchema(schema, `${path}.schema`);
  }
}

function validateMiddleware(value: unknown, path: string): void {
  const middleware = requireObject(value, path);
  requireExactKeys(middleware, ["bean", "beanId", "phase", "order", "mount"], path);
  requireFunction(Reflect.get(middleware, "bean"), `${path}.bean`);
  validateBeanId(Reflect.get(middleware, "beanId"), `${path}.beanId`);
  if (!isWebPhase(Reflect.get(middleware, "phase"))) {
    fail(`${path}.phase must be "observability", "admission", or "application".`);
  }
  requireInteger(Reflect.get(middleware, "order"), `${path}.order`);
  if (!middlewareMounts.has(String(Reflect.get(middleware, "mount")))) {
    fail(`${path}.mount must be "global", "controller", or "route".`);
  }
}

function validateRoutePath(value: unknown, path: string): void {
  const routePath = requireString(value, path);
  if (!routePath.startsWith("/")) {
    fail(`${path} must start with "/".`);
  }
}

// 路由形状归一（与 compiler 的 shapeKey 同源，见 analysis/web-routes.ts 的 routePathOf）：参数段
// 只贡献一个 ":"，参数名不参与区分。这里比编译期多一步过滤空段——编译期的 path 已被
// literalSegmentPattern 校验过不含空段，而本文件按不可信输入处理；而 adapter.ts 的
// WebEngineAdapter 契约要求所有引擎把 /p、/p/、//p 视作同一路径，不过滤就漏掉这类等价重复，
// 于是出现"编译期判为重复、运行时是两条路由"。改归一规则时两侧要同步。
function routeShapeOf(path: string): string {
  return path
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => (segment.startsWith(":") ? ":" : segment))
    .join("/");
}

// 同 method + 同路径形状只能注册一次（#213）：编译期 DUPLICATE_ROUTE 的运行时对位（ADR 0006
// W1 / #152）。检测放在这一层，所有引擎适配器就共享同一份保证，不必各自依赖底层路由库碰巧
// 有没有重复检测。硬错而非警告：重复意味着有一个 handler 永远不会被调用，静默失效比启动失败坏。
function requireUniqueShape(value: unknown, index: number, seen: Map<string, string>): void {
  const path = `routeTable.routes[${index}]`;
  const route = requireObject(value, path);
  // method/path 紧邻的 validateRoute 已验过，这里重取一次是幂等的，换来无断言的窄化
  const method = requireString(Reflect.get(route, "method"), `${path}.method`);
  const routePath = requireString(Reflect.get(route, "path"), `${path}.path`);
  const key = `${method} ${routeShapeOf(routePath)}`;
  const first = seen.get(key);
  if (first !== undefined) {
    fail(
      `${path} registers ${method} ${routePath}, already registered as ${first}. ` +
        "Each method + path shape pair may be registered once; parameter names do not disambiguate.",
    );
  }
  seen.set(key, `${method} ${routePath}`);
}

// 响应闭集(RFC 0012 S3,#275):kind 三变体,encode 当且仅当 table,status 整数
// (table/free-form 必带,passthrough 可缺省 = 运行时 204)。
function validateResponse(value: unknown, path: string): void {
  const response = requireObject(value, path);
  const kind = Reflect.get(response, "kind");
  if (kind === "table") {
    requireExactKeys(response, ["kind", "status", "encode"], path);
    requireInteger(Reflect.get(response, "status"), `${path}.status`);
    requireFunction(Reflect.get(response, "encode"), `${path}.encode`);
    return;
  }
  if (kind === "free-form") {
    requireExactKeys(response, ["kind", "status"], path);
    requireInteger(Reflect.get(response, "status"), `${path}.status`);
    return;
  }
  if (kind === "passthrough") {
    requireExactKeys(response, ["kind", "status"], path);
    const status = Reflect.get(response, "status");
    if (status !== undefined) {
      requireInteger(status, `${path}.status`);
    }
    return;
  }
  fail(`${path}.kind must be "table", "free-form", or "passthrough".`);
}

function validateRoute(value: unknown, path: string): void {
  const route = requireObject(value, path);
  requireExactKeys(
    route,
    [
      "method",
      "path",
      "controller",
      "beanId",
      "handler",
      "invoke",
      "middleware",
      "meta",
      "slots",
      "response",
    ],
    path,
  );
  if (!isHttpMethod(Reflect.get(route, "method"))) {
    fail(`${path}.method must be a supported HTTP method.`);
  }
  validateRoutePath(Reflect.get(route, "path"), `${path}.path`);
  requireFunction(Reflect.get(route, "controller"), `${path}.controller`);
  validateBeanId(Reflect.get(route, "beanId"), `${path}.beanId`);
  const handler = requireString(Reflect.get(route, "handler"), `${path}.handler`);
  if (handler.length === 0) {
    fail(`${path}.handler must not be empty.`);
  }
  requireFunction(Reflect.get(route, "invoke"), `${path}.invoke`);
  const middleware = requireArray(Reflect.get(route, "middleware"), `${path}.middleware`);
  for (const [index, entry] of middleware.entries()) {
    validateMiddleware(entry, `${path}.middleware[${index}]`);
  }
  validateMeta(Reflect.get(route, "meta"), `${path}.meta`);
  const slots = requireArray(Reflect.get(route, "slots"), `${path}.slots`);
  for (const [index, entry] of slots.entries()) {
    validateSlot(entry, `${path}.slots[${index}]`);
  }
  validateResponse(Reflect.get(route, "response"), `${path}.response`);
}

function validateErrorHandler(value: unknown, path: string): void {
  const handler = requireObject(value, path);
  requireExactKeys(handler, ["bean", "beanId", "order", "accepts", "status", "encode"], path);
  requireFunction(Reflect.get(handler, "bean"), `${path}.bean`);
  validateBeanId(Reflect.get(handler, "beanId"), `${path}.beanId`);
  requireInteger(Reflect.get(handler, "order"), `${path}.order`);
  const accepts = Reflect.get(handler, "accepts");
  if (accepts !== undefined) {
    requireFunction(accepts, `${path}.accepts`);
  }
  const status = Reflect.get(handler, "status");
  if (status !== undefined) {
    requireInteger(status, `${path}.status`);
  }
  const encode = Reflect.get(handler, "encode");
  if (encode !== undefined) {
    requireFunction(encode, `${path}.encode`);
  }
}

export function validateGeneratedRouteTable(value: unknown): GeneratedRouteTable {
  const table = requireObject(value, "routeTable");
  requireExactKeys(table, ["schemaVersion", "routes", "errorHandlers"], "routeTable");
  if (Reflect.get(table, "schemaVersion") !== 4) {
    fail("routeTable.schemaVersion must be 4.");
  }
  const routes = requireArray(Reflect.get(table, "routes"), "routeTable.routes");
  const shapes = new Map<string, string>();
  for (const [index, route] of routes.entries()) {
    validateRoute(route, `routeTable.routes[${index}]`);
    requireUniqueShape(route, index, shapes);
  }
  const errorHandlers = requireArray(
    Reflect.get(table, "errorHandlers"),
    "routeTable.errorHandlers",
  );
  for (const [index, handler] of errorHandlers.entries()) {
    validateErrorHandler(handler, `routeTable.errorHandlers[${index}]`);
  }
  // 逐字段复检完成后，值即为契约形状；结构谓词无法一步到位表达这份复合断言
  // // justified: 复检在上方逐键完成，TS 推不回跨函数的窄化
  return value as GeneratedRouteTable;
}
