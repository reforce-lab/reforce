import { ConfigProperties } from "@reforce/config";

interface ServerValues {
  readonly host: string;
  readonly port: number;
}

type SchemaIssue = { readonly message: string; readonly path?: readonly (string | number)[] };
type SchemaResult =
  | { readonly value: ServerValues; readonly issues?: undefined }
  | { readonly issues: readonly SchemaIssue[] };

// 框架不绑定校验库（ADR 0005 决策 2），模板用手写的最小 Standard Schema 实现，不引第三方
// schema 依赖。分层查找交付的是字符串，数字解释由 schema 自己完成；两个字段都有默认值，
// 让不写 .env 的 e2e 场景照常启动。
export const serverSchema = {
  "~standard": {
    version: 1 as const,
    vendor: "reforce-fixture",
    types: undefined as { readonly input: unknown; readonly output: ServerValues } | undefined,
    validate: (value: unknown): SchemaResult => {
      const record = (value ?? {}) as Record<string, unknown>; // 夹具 schema 自行窄化未知输入
      const host = typeof record.host === "string" ? record.host : "fallback-host";
      const port = typeof record.port === "string" ? Number(record.port) : 8080;
      if (Number.isNaN(port)) {
        return { issues: [{ message: "port must be numeric", path: ["port"] }] };
      }
      return { value: { host, port } };
    },
  },
};

export class FixtureServerConfig extends ConfigProperties("fixtureServer", serverSchema) {}
