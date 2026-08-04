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

function validateSchemas(value: unknown, path: string): void {
  const schemas = requireObject(value, path);
  requireExactKeys(schemas, ["params", "query", "body", "response"], path);
  for (const key of ["params", "query", "body", "response"] as const) {
    const schema = Reflect.get(schemas, key);
    if (schema !== undefined) {
      validateStandardSchema(schema, `${path}.${key}`);
    }
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
      "schemas",
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
  validateSchemas(Reflect.get(route, "schemas"), `${path}.schemas`);
}

function validateErrorHandler(value: unknown, path: string): void {
  const handler = requireObject(value, path);
  requireExactKeys(handler, ["bean", "beanId", "order"], path);
  requireFunction(Reflect.get(handler, "bean"), `${path}.bean`);
  validateBeanId(Reflect.get(handler, "beanId"), `${path}.beanId`);
  requireInteger(Reflect.get(handler, "order"), `${path}.order`);
}

export function validateGeneratedRouteTable(value: unknown): GeneratedRouteTable {
  const table = requireObject(value, "routeTable");
  requireExactKeys(table, ["schemaVersion", "routes", "errorHandlers"], "routeTable");
  if (Reflect.get(table, "schemaVersion") !== 1) {
    fail("routeTable.schemaVersion must be 1.");
  }
  const routes = requireArray(Reflect.get(table, "routes"), "routeTable.routes");
  for (const [index, route] of routes.entries()) {
    validateRoute(route, `routeTable.routes[${index}]`);
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
