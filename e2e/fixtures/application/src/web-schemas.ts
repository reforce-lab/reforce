// 路由输入 schema(RFC 0012 S2,#274):契约由 handler 参数的类型标注表达,类型经 typeof
// 追溯到这里的 Standard Schema 时,解码交给 schema(codec:线上 string → 代码 bigint);
// 追溯不到的输入与全部响应由编译器按类型生成解码器/白名单编码器。模板不引第三方校验库。

type SchemaIssue = { readonly message: string; readonly path?: readonly (string | number)[] };

// "~standard".types 是纯类型槽位：spec 里声明为 optional，运行时永远是 undefined。
// SchemaOutput 只从它读输出类型——zod / valibot / arktype 自带这一槽,手写夹具不补的话
// 输出类型推不出来。返回类型带 undefined，所以这里不需要任何类型断言。
function schemaTypes<Output>(): { readonly input: unknown; readonly output: Output } | undefined {
  return undefined;
}

// z.infer 的手写对位:槽位类型写 SchemaOutput<typeof x>,编译器沿 typeof 追溯到 schema 值。
export type SchemaOutput<T> = T extends {
  readonly "~standard": { readonly types?: { readonly output: infer Output } | undefined };
}
  ? Output
  : never;

type SnowflakeResult =
  | { readonly value: { readonly id: bigint }; readonly issues?: undefined }
  | { readonly issues: readonly SchemaIssue[] };

// 线上形状 {id: string} → 代码形状 {id: bigint}（decode 是校验的一部分）。
export const snowflakeParamsSchema = {
  "~standard": {
    version: 1 as const,
    vendor: "reforce-fixture",
    types: schemaTypes<{ readonly id: bigint }>(),
    validate: (value: unknown): SnowflakeResult => {
      const record = (value ?? {}) as Record<string, unknown>; // 夹具 schema 自行窄化未知输入
      if (typeof record.id !== "string" || !/^[0-9]+$/.test(record.id)) {
        return { issues: [{ message: "id must be a numeric string", path: ["id"] }] };
      }
      return { value: { id: BigInt(record.id) } };
    },
  },
};

export type SnowflakeParams = SchemaOutput<typeof snowflakeParamsSchema>;

type CreateUserResult =
  | {
      readonly value: { readonly name: string; readonly age: number };
      readonly issues?: undefined;
    }
  | { readonly issues: readonly SchemaIssue[] };

// 多字段契约(S3 验收清单,#275):缺字段/坏字段一次收齐全部 issues,声明外的多余字段
// 不进输出(schema 输出即白名单)。
export const createUserBodySchema = {
  "~standard": {
    version: 1 as const,
    vendor: "reforce-fixture",
    types: schemaTypes<{ readonly name: string; readonly age: number }>(),
    validate: (value: unknown): CreateUserResult => {
      const record = (value ?? {}) as Record<string, unknown>; // 夹具 schema 自行窄化未知输入
      const name =
        typeof record.name === "string" && record.name.length > 0 ? record.name : undefined;
      const age =
        typeof record.age === "number" && Number.isInteger(record.age) ? record.age : undefined;
      const issues: SchemaIssue[] = [];
      if (name === undefined) {
        issues.push({ message: "name must be a non-empty string", path: ["name"] });
      }
      if (age === undefined) {
        issues.push({ message: "age must be an integer", path: ["age"] });
      }
      if (name === undefined || age === undefined) {
        return { issues };
      }
      return { value: { name, age } };
    },
  },
};

export type CreateUserBody = SchemaOutput<typeof createUserBodySchema>;

// @ResponseSchema 的线上响应 schema(#275):编译器读 ~standard.types 的 **input** 侧作为
// 线上契约;出方向不调用 validate,这里只是占位实现。
function wireSchemaTypes<Wire>(): { readonly input: Wire; readonly output: Wire } | undefined {
  return undefined;
}

export const orderWireSchema = {
  "~standard": {
    version: 1 as const,
    vendor: "reforce-fixture",
    types: wireSchemaTypes<{ readonly id: string; readonly total: number }>(),
    validate: (value: unknown): { readonly value: unknown } => ({ value }),
  },
};
