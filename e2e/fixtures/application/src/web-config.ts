import { ConfigProperties } from "@reforce/config";
import type { WebNodeServeSettings } from "@reforce/web-node";

interface WebServerValues {
  readonly port: number;
  readonly hostname: string;
}

type SchemaIssue = { readonly message: string; readonly path?: readonly (string | number)[] };
type SchemaResult =
  | { readonly value: WebServerValues; readonly issues?: undefined }
  | { readonly issues: readonly SchemaIssue[] };

// 引擎特有配置走 ADR 0005 通道：@reforce/web-node 声明对 WebNodeServeSettings 的开放契约边，
// 应用用 config class 闭合。port 默认 0（临时端口）——e2e 并发起多个实例不抢端口，实际
// 端口从引擎的监听日志读取。
export const webServerSchema = {
  "~standard": {
    version: 1 as const,
    vendor: "reforce-fixture",
    types: undefined as { readonly input: unknown; readonly output: WebServerValues } | undefined,
    validate: (value: unknown): SchemaResult => {
      const record = (value ?? {}) as Record<string, unknown>; // 夹具 schema 自行窄化未知输入
      const hostname = typeof record.hostname === "string" ? record.hostname : "localhost";
      const port = typeof record.port === "string" ? Number(record.port) : 0;
      if (!Number.isInteger(port) || port < 0) {
        return { issues: [{ message: "port must be a non-negative integer", path: ["port"] }] };
      }
      return { value: { hostname, port } };
    },
  },
};

export class WebServerConfig
  extends ConfigProperties("webServer", webServerSchema)
  implements WebNodeServeSettings {}
