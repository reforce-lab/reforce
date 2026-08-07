import type { StandardSchemaV1 } from "@standard-schema/spec";

// 手搓 Standard Schema（仓库不依赖任何 schema 库；spec 是纯类型包）：validate 行为由
// 各用例注入，能力增强（encode / ~standard.jsonSchema）按需叠加。

export function schemaOf<T>(
  validate: (value: unknown) => StandardSchemaV1.Result<T> | Promise<StandardSchemaV1.Result<T>>,
): StandardSchemaV1<unknown, T> {
  return {
    "~standard": { version: 1, vendor: "reforce-test", validate },
  };
}

export function passthroughSchema(): StandardSchemaV1 {
  return schemaOf((value) => ({ value }));
}

export function failingSchema(message: string): StandardSchemaV1 {
  return schemaOf(() => ({ issues: [{ message }] }));
}
