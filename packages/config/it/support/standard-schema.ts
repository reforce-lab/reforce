import type { StandardSchemaV1 } from "@standard-schema/spec";

export type FieldResult<Value> = { readonly value: Value } | { readonly error: string };

export type FieldParser<Value> = (raw: unknown) => FieldResult<Value>;

export interface ObjectSchemaOptions {
  /** 覆盖 Promise 分支：validate 以异步形式返回同样的结果。 */
  readonly async?: boolean;
  /** 观察框架传入 validate 的原始输入（happy path 断言"框架只传字符串"用）。 */
  readonly onValidate?: (input: unknown) => void;
}

// 手工最小 StandardSchemaV1 实现：IT 只需要"逐字段解析对象"的形状，不引入 zod
export function objectSchema<Output extends Record<string, unknown>>(
  fields: { readonly [K in keyof Output]: FieldParser<Output[K]> },
  options: ObjectSchemaOptions = {},
): StandardSchemaV1<unknown, Output> {
  const validate = (input: unknown): StandardSchemaV1.Result<Output> => {
    options.onValidate?.(input);
    const issues: StandardSchemaV1.Issue[] = [];
    const output: Record<string, unknown> = {};
    for (const [key, parseField] of Object.entries(fields)) {
      const raw = typeof input === "object" && input !== null ? Reflect.get(input, key) : undefined;
      const result = parseField(raw);
      if ("error" in result) {
        issues.push({ message: result.error, path: [key] });
        continue;
      }
      output[key] = result.value;
    }
    if (issues.length > 0) {
      return { issues };
    }
    // 逐字段解析成功后 output 的形状就是 Output，但索引赋值无法让 TS 归纳出映射类型
    return { value: output as Output };
  };
  return {
    "~standard": {
      version: 1,
      vendor: "reforce-config-it",
      validate: options.async ? async (input) => validate(input) : validate,
    },
  };
}

export function numberField(): FieldParser<number> {
  return (raw) => {
    if (typeof raw !== "string" || raw.length === 0) {
      return { error: "expected a numeric string" };
    }
    const value = Number(raw);
    return Number.isFinite(value) ? { value } : { error: "expected a numeric string" };
  };
}

export function stringField(): FieldParser<string> {
  return (raw) => (typeof raw === "string" ? { value: raw } : { error: "expected a string" });
}

export function failingField(message: string): FieldParser<never> {
  return () => ({ error: message });
}
