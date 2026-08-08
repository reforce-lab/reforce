import type { StandardSchemaV1 } from "@standard-schema/spec";
import { transformSync } from "@swc/core";
import type { ContractShape, ContractTable } from "@/analysis/type-contract";
import type { BodyRouteSlotModel, StringRouteSlotModel } from "@/analysis/web-model";
import { decoderPreamble } from "@/emission/render-decoders";
import { span } from "../../analysis/support/ir";

// 生成代码的行为回归 harness(#274 完成判据):渲染出的 TS 源码经 swc 剥类型后直接执行,
// 按 #264 附录实测表逐条断言行为。替身理由:生成物在生产里由用户项目 tsc/构建链执行,
// 单测里唯一的边界是"TS 文本 → 可执行函数"。

export function evaluateGenerated<T>(declaration: string, constName: string): T {
  const source = `${decoderPreamble}\n${declaration}\nmodule.exports.value = ${constName};\n`;
  const compiled = transformSync(source, {
    jsc: { parser: { syntax: "typescript" }, target: "es2022" },
    module: { type: "commonjs" },
  }).code;
  const moduleObject: { exports: { value?: T } } = { exports: {} };
  new Function("module", "exports", compiled)(moduleObject, moduleObject.exports);
  const value = moduleObject.exports.value;
  if (value === undefined) {
    throw new Error(`Generated constant ${constName} did not evaluate.`);
  }
  return value;
}

export type EvaluatedDecoder = StandardSchemaV1;

export function validateWith(decoder: EvaluatedDecoder, input: unknown) {
  const result = decoder["~standard"].validate(input);
  if (result instanceof Promise) {
    throw new Error("Generated decoders are synchronous.");
  }
  return result;
}

export function decodedValue(decoder: EvaluatedDecoder, input: unknown): unknown {
  const result = validateWith(decoder, input);
  if ("issues" in result && result.issues !== undefined) {
    throw new Error(`Expected a value, got issues: ${JSON.stringify(result.issues)}`);
  }
  return (result as { value: unknown }).value;
}

export function decodeIssues(decoder: EvaluatedDecoder, input: unknown): readonly string[] {
  const result = validateWith(decoder, input);
  if (!("issues" in result) || result.issues === undefined) {
    throw new Error(
      `Expected issues, got value: ${JSON.stringify((result as { value: unknown }).value)}`,
    );
  }
  return result.issues.map((issue) => issue.message);
}

// ———— ContractTable 便签 ————

export const scalar = (
  kind: "string" | "number" | "bigint" | "boolean" | "date" | "null",
  nullable = false,
): ContractShape => ({ kind: "scalar", scalar: kind, nullable });

export const literalUnion = (
  values: readonly (string | number | boolean | { readonly bigint: string })[],
  nullable = false,
): ContractShape => ({
  kind: "literal",
  values: values.map((value) => {
    if (typeof value === "string") {
      return { scalar: "string", value } as const;
    }
    if (typeof value === "number") {
      return { scalar: "number", value } as const;
    }
    if (typeof value === "boolean") {
      return { scalar: "boolean", value } as const;
    }
    return { scalar: "bigint", value: value.bigint } as const;
  }),
  nullable,
});

export interface FieldSpec {
  readonly name: string;
  readonly shape: ContractShape;
  readonly optional?: boolean;
}

export const objectShape = (fields: readonly FieldSpec[], nullable = false): ContractShape => ({
  kind: "object",
  fields: fields.map((field) => ({
    name: field.name,
    optional: field.optional === true,
    shape: field.shape,
  })),
  nullable,
});

export const arrayShape = (element: ContractShape, nullable = false): ContractShape => ({
  kind: "array",
  element,
  nullable,
});

export const unionShape = (
  discriminant: string,
  members: readonly (readonly [string, ContractShape])[],
  nullable = false,
): ContractShape => ({
  kind: "union",
  discriminant,
  members: members.map(([tag, shape]) => ({ tag: { scalar: "string", value: tag }, shape })),
  nullable,
});

export const referenceShape = (target: string, nullable = false): ContractShape => ({
  kind: "reference",
  target,
  nullable,
});

export const tableOf = (
  root: ContractShape,
  definitions: Readonly<
    Record<string, { readonly typeName: string; readonly shape: ContractShape }>
  > = {},
): ContractTable => ({ root, definitions });

// ———— 槽位模型便签 ————

export function stringSlot(input: {
  readonly kind: "param" | "query" | "header";
  readonly form: "single" | "optional-single" | "contract";
  readonly key?: string;
  readonly table: ContractTable;
}): StringRouteSlotModel {
  return {
    kind: input.kind,
    form: input.form,
    ...(input.key === undefined ? {} : { key: input.key }),
    table: input.table,
    contractSource: { source: "type" },
    span: span("src/controller.ts"),
  };
}

export function bodySlot(table: ContractTable, key?: string): BodyRouteSlotModel {
  return {
    kind: "body",
    ...(key === undefined ? {} : { key }),
    table,
    contractSource: { source: "type" },
    span: span("src/controller.ts"),
  };
}
