import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isObject } from "radashi";
import { isMissingPathError } from "@/project/fs-error";

// routes.json 的完整解析器(#306):routes.json 是编译器写盘的跨包契约,这里按 schemaVersion
// 门独立校验,任何一处形状不对整份拒收——半份路由表渲染出的 explain/OpenAPI 都是错的。
// `reforce explain` 只消费 slot/response 的概要面,`reforce openapi` 消费全量(字段表、
// definitions、@Throws errors 与处理器 body),所以解析器住在 project/ 供两边共用。

// 契约字段表(与 compiler analysis/type-contract 的落盘 JSON 对齐,#273/#275)。cli 不 import
// 编译器内部类型:两边各自持有自己的一半契约,靠 schemaVersion 门同步演进。
export type ManifestScalarKind = "string" | "number" | "bigint" | "boolean" | "date" | "null";

export type ManifestLiteralValue =
  | { readonly scalar: "string"; readonly value: string }
  // bigint 字面量在表里存十进制字符串。
  | { readonly scalar: "bigint"; readonly value: string }
  | { readonly scalar: "number"; readonly value: number }
  | { readonly scalar: "boolean"; readonly value: boolean };

export type ManifestContractShape =
  | {
      readonly kind: "scalar";
      readonly scalar: ManifestScalarKind;
      readonly nullable: boolean;
    }
  | {
      readonly kind: "literal";
      readonly values: readonly ManifestLiteralValue[];
      readonly nullable: boolean;
    }
  | {
      readonly kind: "object";
      readonly fields: readonly ManifestContractField[];
      readonly nullable: boolean;
    }
  | {
      readonly kind: "array";
      readonly element: ManifestContractShape;
      readonly nullable: boolean;
    }
  | {
      readonly kind: "union";
      readonly discriminant: string;
      readonly members: readonly ManifestUnionMember[];
      readonly nullable: boolean;
    }
  | { readonly kind: "reference"; readonly target: string; readonly nullable: boolean };

export interface ManifestContractField {
  readonly name: string;
  readonly optional: boolean;
  readonly shape: ManifestContractShape;
}

export interface ManifestUnionMember {
  readonly tag: ManifestLiteralValue;
  readonly shape: ManifestContractShape;
}

export interface ManifestContractDefinition {
  readonly typeName: string;
  readonly shape: ManifestContractShape;
}

export interface ManifestContractTable {
  readonly root: ManifestContractShape;
  // key = `${声明文件 fileId}#${类型名}`。
  readonly definitions: Readonly<Record<string, ManifestContractDefinition>>;
}

export interface RouteManifestMiddleware {
  readonly beanId: string;
  readonly phase: string;
  readonly order: number;
  readonly mount: string;
}

// 槽位契约节(RFC 0012 S2,#274):bare 槽(request/requestContext/responseHeaders)只有
// slot 一键,数据槽携带键名、形态、来源与字段表。
export interface RouteManifestSlot {
  readonly slot: string;
  readonly key?: string;
  readonly form?: string;
  readonly source?: { readonly kind: string; readonly vendor?: string };
  readonly table?: ManifestContractTable;
}

// 处理器声明的响应形状(#275):passthrough 处理器没有静态可知的形状,body 整体缺席。
export type RouteManifestHandlerBody =
  | { readonly kind: "table"; readonly table: ManifestContractTable }
  | { readonly kind: "free-form" };

// @Throws 条目的 body 比处理器多一个变体(#310):problem = defineHttpError 造的异常,运行时
// 兜底闭集直译 RFC 9457 problem+json,code 是 defineHttpError 实参的静态字面量(非字面量缺席)。
export type RouteManifestThrownBody =
  | RouteManifestHandlerBody
  | { readonly kind: "problem"; readonly code?: string };

// handler 缺席 = problem 变体(#310):没有处理器 bean,状态码与形状由 defineHttpError 声明。
export interface RouteManifestThrownError {
  readonly error: string;
  readonly handler?: string;
  readonly status?: number;
  readonly body?: RouteManifestThrownBody;
}

export interface RouteManifestResponse {
  readonly kind: string;
  readonly status?: number;
  readonly table?: ManifestContractTable;
  readonly errors: readonly RouteManifestThrownError[];
}

export interface RouteManifestContract {
  readonly slots: readonly RouteManifestSlot[];
  readonly response: RouteManifestResponse;
}

export interface RouteManifestEntry {
  readonly method: string;
  readonly path: string;
  readonly controller: {
    readonly beanId: string;
    readonly handler: string;
    readonly exportName?: string;
  };
  readonly middleware: readonly RouteManifestMiddleware[];
  readonly meta: Readonly<Record<string, unknown>>;
  readonly contract: RouteManifestContract;
}

// accepts/status 是 S3(#275)类型化处理器的声明面:accepts 缺席 = match-all。
export interface RouteManifestErrorHandler {
  readonly beanId: string;
  readonly order: number;
  readonly accepts?: { readonly name: string };
  readonly status?: number;
  readonly body?: RouteManifestHandlerBody;
}

export interface RouteManifest {
  readonly routes: readonly RouteManifestEntry[];
  readonly errorHandlers: readonly RouteManifestErrorHandler[];
}

const scalarKinds: ReadonlySet<string> = new Set<ManifestScalarKind>([
  "string",
  "number",
  "bigint",
  "boolean",
  "date",
  "null",
]);

function isScalarKind(value: string): value is ManifestScalarKind {
  return scalarKinds.has(value);
}

function parsedLiteralValue(value: unknown): ManifestLiteralValue | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const scalar = Reflect.get(value, "scalar");
  const literal = Reflect.get(value, "value");
  if (scalar === "number" && typeof literal === "number") {
    return { scalar, value: literal };
  }
  if (scalar === "boolean" && typeof literal === "boolean") {
    return { scalar, value: literal };
  }
  if ((scalar === "string" || scalar === "bigint") && typeof literal === "string") {
    return { scalar, value: literal };
  }
  return undefined;
}

function parsedField(value: unknown): ManifestContractField | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const name = Reflect.get(value, "name");
  const optional = Reflect.get(value, "optional");
  const shape = parsedShape(Reflect.get(value, "shape"));
  if (typeof name !== "string" || typeof optional !== "boolean" || shape === undefined) {
    return undefined;
  }
  return { name, optional, shape };
}

function parsedUnionMember(value: unknown): ManifestUnionMember | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const tag = parsedLiteralValue(Reflect.get(value, "tag"));
  const shape = parsedShape(Reflect.get(value, "shape"));
  if (tag === undefined || shape === undefined) {
    return undefined;
  }
  return { tag, shape };
}

function parsedAll<T>(
  value: unknown,
  parse: (entry: unknown) => T | undefined,
): readonly T[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parsed: T[] = [];
  for (const entry of value) {
    const result = parse(entry);
    if (result === undefined) {
      return undefined;
    }
    parsed.push(result);
  }
  return parsed;
}

type ShapeParser = (value: object, nullable: boolean) => ManifestContractShape | undefined;

// kind → 解析策略:六个变体各自成小函数,parsedShape 只做 kind 分派。
const shapeParsers: Readonly<Record<string, ShapeParser>> = {
  scalar: (value, nullable) => {
    const scalar = Reflect.get(value, "scalar");
    if (typeof scalar !== "string" || !isScalarKind(scalar)) {
      return undefined;
    }
    return { kind: "scalar", scalar, nullable };
  },
  literal: (value, nullable) => {
    const values = parsedAll(Reflect.get(value, "values"), parsedLiteralValue);
    return values === undefined ? undefined : { kind: "literal", values, nullable };
  },
  object: (value, nullable) => {
    const fields = parsedAll(Reflect.get(value, "fields"), parsedField);
    return fields === undefined ? undefined : { kind: "object", fields, nullable };
  },
  array: (value, nullable) => {
    const element = parsedShape(Reflect.get(value, "element"));
    return element === undefined ? undefined : { kind: "array", element, nullable };
  },
  union: (value, nullable) => {
    const discriminant = Reflect.get(value, "discriminant");
    const members = parsedAll(Reflect.get(value, "members"), parsedUnionMember);
    if (typeof discriminant !== "string" || members === undefined) {
      return undefined;
    }
    return { kind: "union", discriminant, members, nullable };
  },
  reference: (value, nullable) => {
    const target = Reflect.get(value, "target");
    return typeof target === "string" ? { kind: "reference", target, nullable } : undefined;
  },
};

function parsedShape(value: unknown): ManifestContractShape | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const kind = Reflect.get(value, "kind");
  const nullable = Reflect.get(value, "nullable");
  if (typeof kind !== "string" || typeof nullable !== "boolean") {
    return undefined;
  }
  return shapeParsers[kind]?.(value, nullable);
}

function parsedTable(value: unknown): ManifestContractTable | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const root = parsedShape(Reflect.get(value, "root"));
  const rawDefinitions = Reflect.get(value, "definitions");
  if (root === undefined || !isObject(rawDefinitions)) {
    return undefined;
  }
  const definitions: Record<string, ManifestContractDefinition> = {};
  for (const [key, entry] of Object.entries(rawDefinitions)) {
    if (!isObject(entry)) {
      return undefined;
    }
    const typeName = Reflect.get(entry, "typeName");
    const shape = parsedShape(Reflect.get(entry, "shape"));
    if (typeof typeName !== "string" || shape === undefined) {
      return undefined;
    }
    definitions[key] = { typeName, shape };
  }
  return { root, definitions };
}

function parsedHandlerBody(value: unknown): RouteManifestHandlerBody | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const kind = Reflect.get(value, "kind");
  if (kind === "free-form") {
    return { kind };
  }
  if (kind !== "table") {
    return undefined;
  }
  const table = parsedTable(Reflect.get(value, "table"));
  return table === undefined ? undefined : { kind, table };
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

// table 键缺席合法(bare 槽),存在但坏了拒收——「有表但读不出」与「本就无表」必须可区分,
// openapi 靠这条把静默丢参数挡在解析层。
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
  const rawTable = Reflect.get(value, "table");
  const table = rawTable === undefined ? undefined : parsedTable(rawTable);
  if (rawTable !== undefined && table === undefined) {
    return undefined;
  }
  return {
    slot,
    ...(typeof key === "string" ? { key } : {}),
    ...(typeof form === "string" ? { form } : {}),
    ...(typeof sourceKind === "string"
      ? { source: { kind: sourceKind, ...(typeof vendor === "string" ? { vendor } : {}) } }
      : {}),
    ...(table === undefined ? {} : { table }),
  };
}

function parsedThrownBody(value: unknown): RouteManifestThrownBody | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  if (Reflect.get(value, "kind") !== "problem") {
    return parsedHandlerBody(value);
  }
  const code = Reflect.get(value, "code");
  return { kind: "problem", ...(typeof code === "string" ? { code } : {}) };
}

function parsedThrownError(value: unknown): RouteManifestThrownError | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const error = Reflect.get(value, "error");
  const handler = Reflect.get(value, "handler");
  const status = Reflect.get(value, "status");
  if (typeof error !== "string" || (handler !== undefined && typeof handler !== "string")) {
    return undefined;
  }
  const rawBody = Reflect.get(value, "body");
  const body = rawBody === undefined ? undefined : parsedThrownBody(rawBody);
  if (rawBody !== undefined && body === undefined) {
    return undefined;
  }
  return {
    error,
    ...(handler === undefined ? {} : { handler }),
    ...(typeof status === "number" ? { status } : {}),
    ...(body === undefined ? {} : { body }),
  };
}

function parsedResponse(value: unknown): RouteManifestResponse | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const kind = Reflect.get(value, "kind");
  if (typeof kind !== "string") {
    return undefined;
  }
  const status = Reflect.get(value, "status");
  const rawTable = Reflect.get(value, "table");
  const table = rawTable === undefined ? undefined : parsedTable(rawTable);
  if (rawTable !== undefined && table === undefined) {
    return undefined;
  }
  const rawErrors = Reflect.get(value, "errors");
  const errors = rawErrors === undefined ? [] : parsedAll(rawErrors, parsedThrownError);
  if (errors === undefined) {
    return undefined;
  }
  return {
    kind,
    ...(typeof status === "number" ? { status } : {}),
    ...(table === undefined ? {} : { table }),
    errors,
  };
}

function parsedContract(value: unknown): RouteManifestContract | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const slots = parsedAll(Reflect.get(value, "slots"), parsedSlot);
  if (slots === undefined) {
    return undefined;
  }
  const response = parsedResponse(Reflect.get(value, "response"));
  if (response === undefined) {
    return undefined;
  }
  return { slots, response };
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
  const exportName = Reflect.get(controller, "exportName");
  if (typeof beanId !== "string" || typeof handler !== "string") {
    return undefined;
  }
  const chain = parsedAll(middleware, parsedMiddleware);
  if (chain === undefined) {
    return undefined;
  }
  const contract = parsedContract(Reflect.get(value, "contract"));
  if (contract === undefined) {
    return undefined;
  }
  return {
    method,
    path,
    controller: {
      beanId,
      handler,
      ...(typeof exportName === "string" ? { exportName } : {}),
    },
    middleware: chain,
    meta: isObject(meta) ? (meta as Record<string, unknown>) : {}, // JSON 树，形状由生成器保证
    contract,
  };
}

function parsedErrorHandler(value: unknown): RouteManifestErrorHandler | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const beanId = Reflect.get(value, "beanId");
  const order = Reflect.get(value, "order");
  if (typeof beanId !== "string" || typeof order !== "number") {
    return undefined;
  }
  const accepts = Reflect.get(value, "accepts");
  const acceptsName = isObject(accepts) ? Reflect.get(accepts, "name") : undefined;
  const status = Reflect.get(value, "status");
  const rawBody = Reflect.get(value, "body");
  const body = rawBody === undefined ? undefined : parsedHandlerBody(rawBody);
  if (rawBody !== undefined && body === undefined) {
    return undefined;
  }
  return {
    beanId,
    order,
    ...(typeof acceptsName === "string" ? { accepts: { name: acceptsName } } : {}),
    ...(typeof status === "number" ? { status } : {}),
    ...(body === undefined ? {} : { body }),
  };
}

export function parseRouteManifestBytes(bytes: Uint8Array): RouteManifest | undefined {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
  // 4 = @Throws 认 defineHttpError + schema 槽线上侧表(#310),与生成器/运行时的版本门同步。
  if (!isObject(value) || Reflect.get(value, "schemaVersion") !== 4) {
    return undefined;
  }
  const routes = parsedAll(Reflect.get(value, "routes"), parsedRoute);
  const errorHandlers = parsedAll(Reflect.get(value, "errorHandlers"), parsedErrorHandler);
  if (routes === undefined || errorHandlers === undefined) {
    return undefined;
  }
  return { routes, errorHandlers };
}

export interface RouteManifestReadResult {
  readonly manifest?: RouteManifest;
  readonly problem?: string;
}

// explain 与 openapi 共用的读取面:缺失与坏形状的话术在这里定死,两条命令一字不差。
export async function readRouteManifest(projectRoot: string): Promise<RouteManifestReadResult> {
  const routesPath = join(projectRoot, ".reforce", "generated", "routes.json");
  let bytes: Uint8Array;
  try {
    bytes = await readFile(routesPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return {
        problem: `No generated route table at ${routesPath}. Run reforce build or reforce dev first.`,
      };
    }
    throw error;
  }
  const manifest = parseRouteManifestBytes(bytes);
  if (manifest === undefined) {
    return {
      problem: `The generated route table at ${routesPath} is not valid. Rebuild the application.`,
    };
  }
  return { manifest };
}
