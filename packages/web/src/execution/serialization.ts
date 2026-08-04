import type { StandardSchemaV1 } from "@standard-schema/spec";
import { isObject } from "radashi";
import { ResponseSerializationError } from "@/errors";

// 响应序列化（ADR 0006 W5）：schema 驱动的特化序列化器 + 字段白名单，启动时按路由装配一次，
// 热路径零决策。诚实的分层：
// - schema 暴露 encode（zod codec 的实例方法）→ 双向转换路径，runtime→wire 交给 schema 自己；
// - 否则 schema 暴露 Standard JSON Schema 导出（~standard.jsonSchema，spec v1.1）→ 由输出
//   JSON Schema 预构建字段白名单投影（fast-json-stringify 思路的启动期特化）；
// - 否则退化为 validate（Standard Schema 只保证单向校验；是否剥除多余字段取决于 vendor）。
// bigint 一律序列化为 JSON 字符串（雪花 ID 语义，JSON.stringify 原生对 bigint 抛异常）。

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function jsonResponse(value: unknown): Response {
  const rendered = JSON.stringify(value, bigintReplacer);
  if (rendered === undefined) {
    throw new ResponseSerializationError("the handler return value is not JSON-serializable.");
  }
  return new Response(rendered, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

type EncodeCapableSchema = StandardSchemaV1 & {
  encode(value: unknown): unknown;
};

function encodeCapable(schema: StandardSchemaV1): schema is EncodeCapableSchema {
  return typeof Reflect.get(schema, "encode") === "function";
}

type JsonSchemaCapableSchema = StandardSchemaV1 & StandardJsonSchemaProps;

interface StandardJsonSchemaProps {
  readonly "~standard": StandardSchemaV1["~standard"] & {
    readonly jsonSchema: {
      readonly output: (options: { readonly target: string }) => Record<string, unknown>;
    };
  };
}

function jsonSchemaCapable(schema: StandardSchemaV1): schema is JsonSchemaCapableSchema {
  const converter = Reflect.get(schema["~standard"], "jsonSchema");
  return isObject(converter) && typeof Reflect.get(converter, "output") === "function";
}

function outputJsonSchema(schema: JsonSchemaCapableSchema): Record<string, unknown> | undefined {
  // spec 允许对不支持的 target 直接 throw；两个推荐 target 依次尝试，全部失败则退回 validate 路径。
  for (const target of ["draft-2020-12", "draft-07"]) {
    try {
      return schema["~standard"].jsonSchema.output({ target });
    } catch {
      // try the next target
    }
  }
  return undefined;
}

type Projector = (value: unknown) => unknown;

const identity: Projector = (value) => value;

// 由输出 JSON Schema 预构建白名单投影：object 只保留 properties 声明的字段（映射漏删的
// entity 字段也不会出线），array 逐元素投影；无法静态识别的子树保持原样——白名单只收紧
// 已声明的形状，不猜测未声明的。
function projectorFromJsonSchema(schema: unknown): Projector {
  if (!isObject(schema)) {
    return identity;
  }
  const type = Reflect.get(schema, "type");
  if (type === "object") {
    const properties = Reflect.get(schema, "properties");
    if (!isObject(properties)) {
      return identity;
    }
    const fields = Object.entries(properties).map(
      ([key, propertySchema]) => [key, projectorFromJsonSchema(propertySchema)] as const,
    );
    return (value) => {
      if (!isObject(value)) {
        return value;
      }
      const projected: Record<string, unknown> = {};
      for (const [key, project] of fields) {
        if (Object.hasOwn(value, key)) {
          projected[key] = project(Reflect.get(value, key));
        }
      }
      return projected;
    };
  }
  if (type === "array") {
    const items = Reflect.get(schema, "items");
    const projectItem = projectorFromJsonSchema(items);
    if (projectItem === identity) {
      return identity;
    }
    return (value) => (Array.isArray(value) ? value.map(projectItem) : value);
  }
  return identity;
}

export type ResponseSerializer = (value: unknown) => Promise<Response>;

async function encodeWithSchema(schema: EncodeCapableSchema, value: unknown): Promise<unknown> {
  try {
    return await schema.encode(value);
  } catch (cause) {
    throw new ResponseSerializationError("the response schema failed to encode the value.", {
      cause,
    });
  }
}

async function validateWithSchema(schema: StandardSchemaV1, value: unknown): Promise<unknown> {
  const result = await schema["~standard"].validate(value);
  if (result.issues !== undefined) {
    throw new ResponseSerializationError(
      [
        `the handler return value failed the response schema with ${result.issues.length} issue(s):`,
        ...result.issues.map((issue) => `- ${issue.message}`),
      ].join("\n"),
    );
  }
  return result.value;
}

export function createResponseSerializer(schema: StandardSchemaV1 | undefined): ResponseSerializer {
  if (schema === undefined) {
    return async (value) => {
      if (value instanceof Response) {
        return value;
      }
      throw new ResponseSerializationError(
        "the route declares no response schema, so the handler must return a Response.",
      );
    };
  }
  if (encodeCapable(schema)) {
    return async (value) =>
      value instanceof Response ? value : jsonResponse(await encodeWithSchema(schema, value));
  }
  if (jsonSchemaCapable(schema)) {
    const outputSchema = outputJsonSchema(schema);
    if (outputSchema !== undefined) {
      const project = projectorFromJsonSchema(outputSchema);
      return async (value) =>
        value instanceof Response
          ? value
          : jsonResponse(project(await validateWithSchema(schema, value)));
    }
  }
  return async (value) =>
    value instanceof Response ? value : jsonResponse(await validateWithSchema(schema, value));
}
