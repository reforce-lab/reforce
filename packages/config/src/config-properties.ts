import type { StandardSchemaV1 } from "@standard-schema/spec";

export const configPropertiesMetadata: unique symbol = Symbol("reforce.configPropertiesMetadata");

export interface ConfigPropertiesMetadata {
  readonly prefix: string;
  readonly schema: StandardSchemaV1;
}

export interface ConfigPropertiesClass<Output extends object> {
  new (values: Output): Output;
}

// 前缀是环境变量名的坐标系起点，必须能被 splitWords 无歧义地拆词，
// 所以限定为点分隔的 camelCase 词（ADR 0005）
const prefixPattern = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$/;

function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  if (typeof value !== "object" || value === null || !("~standard" in value)) {
    return false;
  }
  const props = value["~standard"];
  if (typeof props !== "object" || props === null) {
    return false;
  }
  return (
    "version" in props &&
    props.version === 1 &&
    "validate" in props &&
    typeof props.validate === "function"
  );
}

export function ConfigProperties<Schema extends StandardSchemaV1<unknown, object>>(
  prefix: string,
  schema: Schema,
): ConfigPropertiesClass<StandardSchemaV1.InferOutput<Schema>> {
  if (typeof prefix !== "string" || !prefixPattern.test(prefix)) {
    throw new TypeError(
      `ConfigProperties prefix must be dot-separated camelCase words (received ${JSON.stringify(prefix)}).`,
    );
  }
  if (!isStandardSchema(schema)) {
    throw new TypeError(
      "ConfigProperties schema must implement Standard Schema v1 (an object with a `~standard` property carrying `version: 1` and a `validate` function).",
    );
  }

  class ConfigPropertiesBase {
    // 同一构造器同时服务框架绑定与测试手工构造，因此不经过 schema 校验（ADR 0005 决策 1.2）
    constructor(values: object) {
      Object.assign(this, values);
    }
  }
  Object.defineProperty(ConfigPropertiesBase, configPropertiesMetadata, {
    value: Object.freeze({ prefix, schema }),
  });
  // Object.assign 把 schema 输出的全部字段挂到 this 上，"实例类型即 schema 输出"
  // 超出了 TS 对类声明的推导能力，只能以断言声明返回类型（ADR 0005 决策 1.2）
  return ConfigPropertiesBase as ConfigPropertiesClass<StandardSchemaV1.InferOutput<Schema>>;
}

function isConfigPropertiesMetadata(value: unknown): value is ConfigPropertiesMetadata {
  return (
    typeof value === "object" &&
    value !== null &&
    "prefix" in value &&
    typeof value.prefix === "string" &&
    "schema" in value &&
    isStandardSchema(value.schema)
  );
}

export function readConfigPropertiesMetadata(target: object): ConfigPropertiesMetadata | undefined {
  const value: unknown = Reflect.get(target, configPropertiesMetadata);
  return isConfigPropertiesMetadata(value) ? value : undefined;
}
