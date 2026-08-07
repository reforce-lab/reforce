import { componentNamesOf, jsonSchemaOf, type OpenApiSchema } from "@/openapi/schema";
import type {
  ManifestContractShape,
  ManifestContractTable,
  RouteManifest,
  RouteManifestEntry,
  RouteManifestSlot,
  RouteManifestThrownError,
} from "@/project/route-manifest";

// routes.json → OpenAPI 3.2.0(#306):纯数据到纯数据的装配,不运行编译器。文档只转述表里
// 静态可知的事实——passthrough 响应与无状态码的 @Throws 条目没有可写的形状,不猜。
// 版本号 3.2.0 为 2026-08 时点 OAS 的最新发布(https://spec.openapis.org/oas/)。

const documentedParameterSlots: Readonly<Record<string, string>> = {
  param: "path",
  query: "query",
  header: "header",
};

// 校验 400 的线上形状(ADR 0013 决议 7,#294):RFC 9457 problem+json + code/source/issues
// 扩展成员。RFC 规定客户端必须忽略不认识的扩展,所以这里不写 additionalProperties: false。
const validationProblemComponent = "ReforceValidationProblem";

const validationProblemSchema: OpenApiSchema = {
  type: "object",
  properties: {
    type: { type: "string" },
    title: { type: "string" },
    status: { type: "integer" },
    code: { type: "string", const: "REQUEST_VALIDATION_FAILED" },
    source: { type: "string", enum: ["body", "params", "query", "header"] },
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          message: { type: "string" },
          path: { type: "array", items: { type: ["string", "number"] } },
        },
        required: ["message"],
      },
    },
  },
  required: ["type", "title", "status", "code", "source", "issues"],
};

function tablesOf(manifest: RouteManifest): readonly ManifestContractTable[] {
  const tables: ManifestContractTable[] = [];
  for (const route of manifest.routes) {
    for (const slot of route.contract.slots) {
      if (slot.table !== undefined) {
        tables.push(slot.table);
      }
    }
    const response = route.contract.response;
    if (response.table !== undefined) {
      tables.push(response.table);
    }
    for (const thrown of response.errors) {
      if (thrown.body?.kind === "table") {
        tables.push(thrown.body.table);
      }
    }
  }
  return tables;
}

function isDataSlot(slot: RouteManifestSlot): boolean {
  return (
    slot.table !== undefined && (slot.slot === "body" || slot.slot in documentedParameterSlots)
  );
}

// `:id` → `{id}`:段级替换,OpenAPI 的模板语法。
function openApiPathOf(path: string): string {
  return path
    .split("/")
    .map((segment) => (segment.startsWith(":") ? `{${segment.slice(1)}}` : segment))
    .join("/");
}

// 契约形态槽的根可能是命名类型引用:参数展开需要真实的字段列表,沿 definitions 解引用。
// 表由编译器闭合($ref 闭递归),循环引用做不成对象根,seen 守卫只防坏表死循环。
function resolvedObjectShape(
  shape: ManifestContractShape,
  table: ManifestContractTable,
): Extract<ManifestContractShape, { kind: "object" }> | undefined {
  let current = shape;
  const seen = new Set<string>();
  while (current.kind === "reference") {
    if (seen.has(current.target)) {
      return undefined;
    }
    seen.add(current.target);
    const definition = table.definitions[current.target];
    if (definition === undefined) {
      return undefined;
    }
    current = definition.shape;
  }
  return current.kind === "object" ? current : undefined;
}

function singleKeyParameter(
  slot: RouteManifestSlot,
  table: ManifestContractTable,
  location: string,
  nameOf: ReadonlyMap<string, string>,
): readonly OpenApiSchema[] {
  if (slot.key === undefined) {
    return [];
  }
  return [
    {
      name: slot.key,
      in: location,
      required: location === "path" || slot.form === "single",
      schema: jsonSchemaOf(table.root, nameOf),
    },
  ];
}

// 契约形态(含投影):解码按整个契约跑,线上参数就是根对象的全部字段——投影 key 只
// 决定 handler 参数值,不改线上契约,这里忽略。
function contractParameters(
  table: ManifestContractTable,
  location: string,
  nameOf: ReadonlyMap<string, string>,
): readonly OpenApiSchema[] {
  const object = resolvedObjectShape(table.root, table);
  if (object === undefined) {
    return [];
  }
  return object.fields.map((field) => ({
    name: field.name,
    in: location,
    required: location === "path" || !field.optional,
    schema: jsonSchemaOf(field.shape, nameOf),
  }));
}

function parametersOf(
  route: RouteManifestEntry,
  nameOf: ReadonlyMap<string, string>,
): readonly OpenApiSchema[] {
  const parameters: OpenApiSchema[] = [];
  for (const slot of route.contract.slots) {
    const location = documentedParameterSlots[slot.slot];
    if (location === undefined || slot.table === undefined) {
      continue;
    }
    const singleKey = slot.form === "single" || slot.form === "optional-single";
    parameters.push(
      ...(singleKey
        ? singleKeyParameter(slot, slot.table, location, nameOf)
        : contractParameters(slot.table, location, nameOf)),
    );
  }
  return parameters;
}

function requestBodyOf(
  route: RouteManifestEntry,
  nameOf: ReadonlyMap<string, string>,
): OpenApiSchema | undefined {
  const body = route.contract.slots.find((slot) => slot.slot === "body");
  if (body?.table === undefined) {
    return undefined;
  }
  return {
    required: true,
    content: { "application/json": { schema: jsonSchemaOf(body.table.root, nameOf) } },
  };
}

function successResponseOf(
  route: RouteManifestEntry,
  nameOf: ReadonlyMap<string, string>,
): { readonly key: string; readonly value: OpenApiSchema } {
  const response = route.contract.response;
  if (response.kind === "table" && response.table !== undefined) {
    return {
      key: String(response.status ?? 200),
      value: {
        description: "Successful response.",
        content: {
          "application/json": { schema: jsonSchemaOf(response.table.root, nameOf) },
        },
      },
    };
  }
  if (response.kind === "free-form") {
    return {
      key: String(response.status ?? 200),
      value: {
        description:
          "Free-form response: the return type declares no contract, so the value is serialized as-is.",
        content: { "application/json": { schema: { type: "object" } } },
      },
    };
  }
  // passthrough:handler 直返 Response(或 void 用声明的状态码答复),形状静态不可知。
  return {
    key: response.status === undefined ? "default" : String(response.status),
    value: {
      description: "The handler builds the Response itself; the body shape is not declared.",
    },
  };
}

function thrownBodySchema(
  thrown: RouteManifestThrownError,
  nameOf: ReadonlyMap<string, string>,
): OpenApiSchema | undefined {
  if (thrown.body === undefined) {
    return undefined;
  }
  if (thrown.body.kind === "free-form") {
    return { type: "object" };
  }
  return jsonSchemaOf(thrown.body.table.root, nameOf);
}

// @Throws 条目按处理器声明的状态码归组;同状态多形状去重后 oneOf。无状态码的条目
// (passthrough 处理器)没有可写的响应行,略过——文档只收静态可知的事实。
// 同状态多形状按稳定序列化指纹去重:同一处理器被多个错误命中时只出一份 schema。
function dedupedBodySchemas(
  group: readonly RouteManifestThrownError[],
  nameOf: ReadonlyMap<string, string>,
): readonly OpenApiSchema[] {
  const schemas: OpenApiSchema[] = [];
  const seen = new Set<string>();
  for (const thrown of group) {
    const schema = thrownBodySchema(thrown, nameOf);
    if (schema === undefined) {
      continue;
    }
    const fingerprint = JSON.stringify(schema);
    if (!seen.has(fingerprint)) {
      seen.add(fingerprint);
      schemas.push(schema);
    }
  }
  return schemas;
}

function thrownResponsesOf(
  route: RouteManifestEntry,
  nameOf: ReadonlyMap<string, string>,
): ReadonlyMap<string, OpenApiSchema> {
  const byStatus = new Map<string, RouteManifestThrownError[]>();
  for (const thrown of route.contract.response.errors) {
    if (thrown.status === undefined) {
      continue;
    }
    const key = String(thrown.status);
    const group = byStatus.get(key) ?? [];
    group.push(thrown);
    byStatus.set(key, group);
  }
  const responses = new Map<string, OpenApiSchema>();
  for (const [status, group] of byStatus) {
    const names = group.map((thrown) => thrown.error).join(", ");
    const schemas = dedupedBodySchemas(group, nameOf);
    responses.set(status, {
      description: `Declared by @Throws: ${names}.`,
      ...(schemas.length === 0
        ? {}
        : {
            content: {
              "application/json": {
                schema: schemas.length === 1 ? schemas[0] : { oneOf: schemas },
              },
            },
          }),
    });
  }
  return responses;
}

function responsesOf(
  route: RouteManifestEntry,
  nameOf: ReadonlyMap<string, string>,
): Record<string, OpenApiSchema> {
  const responses: Record<string, OpenApiSchema> = {};
  const success = successResponseOf(route, nameOf);
  responses[success.key] = success.value;
  // 有数据槽就有编译器生成的校验:400 是确定性框架行为,自动挂上。@Throws 显式声明的
  // 400 是用户拍板的语义,声明的赢。
  if (route.contract.slots.some(isDataSlot)) {
    responses["400"] = {
      description: "Request validation failed.",
      content: {
        "application/problem+json": {
          schema: { $ref: `#/components/schemas/${validationProblemComponent}` },
        },
      },
    };
  }
  for (const [status, value] of thrownResponsesOf(route, nameOf)) {
    responses[status] = value;
  }
  return responses;
}

function tagOf(route: RouteManifestEntry): string {
  const exportName = route.controller.exportName;
  if (exportName !== undefined) {
    return exportName;
  }
  const hash = route.controller.beanId.lastIndexOf("#");
  return hash === -1 ? route.controller.beanId : route.controller.beanId.slice(hash + 1);
}

// operationId = `${controller 导出名}_${handler}`;同名(同 handler 挂多方法)加方法后缀。
function operationIdsOf(manifest: RouteManifest): ReadonlyMap<RouteManifestEntry, string> {
  const counts = new Map<string, number>();
  for (const route of manifest.routes) {
    const base = `${tagOf(route)}_${route.controller.handler}`;
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  const ids = new Map<RouteManifestEntry, string>();
  for (const route of manifest.routes) {
    const base = `${tagOf(route)}_${route.controller.handler}`;
    ids.set(route, (counts.get(base) ?? 1) > 1 ? `${base}_${route.method.toLowerCase()}` : base);
  }
  return ids;
}

export function openApiDocumentOf(manifest: RouteManifest): Record<string, unknown> {
  const nameOf = componentNamesOf(tablesOf(manifest));
  const operationIds = operationIdsOf(manifest);
  const paths: Record<string, Record<string, unknown>> = {};
  let hasValidation = false;
  for (const route of manifest.routes) {
    const path = openApiPathOf(route.path);
    const operations = paths[path] ?? {};
    paths[path] = operations;
    const parameters = parametersOf(route, nameOf);
    const requestBody = requestBodyOf(route, nameOf);
    hasValidation ||= route.contract.slots.some(isDataSlot);
    operations[route.method.toLowerCase()] = {
      operationId: operationIds.get(route),
      tags: [tagOf(route)],
      ...(parameters.length === 0 ? {} : { parameters }),
      ...(requestBody === undefined ? {} : { requestBody }),
      responses: responsesOf(route, nameOf),
    };
  }
  const schemas: Record<string, OpenApiSchema> = {};
  for (const table of tablesOf(manifest)) {
    for (const [key, definition] of Object.entries(table.definitions)) {
      const componentName = nameOf.get(key);
      if (componentName !== undefined && !(componentName in schemas)) {
        schemas[componentName] = jsonSchemaOf(definition.shape, nameOf);
      }
    }
  }
  if (hasValidation) {
    schemas[validationProblemComponent] = validationProblemSchema;
  }
  return {
    openapi: "3.2.0",
    // 应用名与版本不在 routes.json 里,不猜:占位值让消费者自行覆写。
    info: { title: "Reforce application", version: "0.0.0" },
    paths,
    ...(Object.keys(schemas).length === 0 ? {} : { components: { schemas } }),
  };
}
