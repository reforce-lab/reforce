// 路由 schema（ADR 0006 W5）：与 server-config 同理，模板用手写的最小 Standard Schema，
// 不引第三方校验库。三种形态各占一个：
// - codec（validate 即 decode，另带 encode 实例方法）：雪花 ID 线上 string ↔ 代码 bigint；
// - jsonSchema 导出（spec v1.1）：驱动编译期字段白名单投影，多余字段不出线；
// - 纯 validate：负向校验产出 issues。

type SchemaIssue = { readonly message: string; readonly path?: readonly (string | number)[] };

interface SnowflakeParams {
  readonly id: bigint;
}

type SnowflakeResult =
  | { readonly value: SnowflakeParams; readonly issues?: undefined }
  | { readonly issues: readonly SchemaIssue[] };

// 线上形状 {id: string} → 代码形状 {id: bigint}（decode 是校验的一部分）。
export const snowflakeParamsSchema = {
  "~standard": {
    version: 1 as const,
    vendor: "reforce-fixture",
    validate: (value: unknown): SnowflakeResult => {
      const record = (value ?? {}) as Record<string, unknown>; // 夹具 schema 自行窄化未知输入
      if (typeof record.id !== "string" || !/^[0-9]+$/.test(record.id)) {
        return { issues: [{ message: "id must be a numeric string", path: ["id"] }] };
      }
      return { value: { id: BigInt(record.id) } };
    },
  },
};

interface UserView {
  readonly id: bigint;
  readonly name: string;
}

// encode 是 zod codec 的结构面（序列化器结构探测）：runtime→wire，bigint 回到 string。
export const userResponseSchema = {
  "~standard": {
    version: 1 as const,
    vendor: "reforce-fixture",
    validate: (value: unknown) => ({ value }),
  },
  encode: (value: unknown): unknown => {
    const view = value as UserView; // handler 返回值类型由路由声明钉死，夹具 encode 直接窄化
    return { id: view.id.toString(), name: view.name };
  },
};

// jsonSchema 导出驱动白名单：secret 字段即使被 handler 返回也不出线。
export const profileResponseSchema = {
  "~standard": {
    version: 1 as const,
    vendor: "reforce-fixture",
    validate: (value: unknown) => ({ value }),
    jsonSchema: {
      output: (_options: { readonly target: string }): Record<string, unknown> => ({
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
        },
      }),
    },
  },
};

interface CreateUserBody {
  readonly name: string;
}

type CreateUserResult =
  | { readonly value: CreateUserBody; readonly issues?: undefined }
  | { readonly issues: readonly SchemaIssue[] };

export const createUserBodySchema = {
  "~standard": {
    version: 1 as const,
    vendor: "reforce-fixture",
    validate: (value: unknown): CreateUserResult => {
      const record = (value ?? {}) as Record<string, unknown>; // 夹具 schema 自行窄化未知输入
      if (typeof record.name !== "string" || record.name.length === 0) {
        return { issues: [{ message: "name must be a non-empty string", path: ["name"] }] };
      }
      return { value: { name: record.name } };
    },
  },
};

interface AuditQuery {
  readonly delay: number;
}

type AuditQueryResult =
  | { readonly value: AuditQuery; readonly issues?: undefined }
  | { readonly issues: readonly SchemaIssue[] };

// 查询串 decode：线上 string → 代码 number，缺省 0。
export const auditQuerySchema = {
  "~standard": {
    version: 1 as const,
    vendor: "reforce-fixture",
    validate: (value: unknown): AuditQueryResult => {
      const record = (value ?? {}) as Record<string, unknown>; // 夹具 schema 自行窄化未知输入
      const raw = typeof record.delay === "string" ? record.delay : "0";
      const delay = Number(raw);
      if (!Number.isInteger(delay) || delay < 0) {
        return { issues: [{ message: "delay must be a non-negative integer", path: ["delay"] }] };
      }
      return { value: { delay } };
    },
  },
};

export const auditResponseSchema = {
  "~standard": {
    version: 1 as const,
    vendor: "reforce-fixture",
    validate: (value: unknown) => ({ value }),
  },
};
