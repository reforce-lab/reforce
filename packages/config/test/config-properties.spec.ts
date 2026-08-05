import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, test } from "vitest";
import { ConfigProperties, readConfigPropertiesMetadata } from "@/config-properties";

interface ServerValues {
  readonly port: number;
}

function serverSchema(): StandardSchemaV1<unknown, ServerValues> {
  return {
    "~standard": {
      version: 1,
      vendor: "reforce-test",
      validate: (value) => {
        if (typeof value === "object" && value !== null && "port" in value) {
          const port = Number(value.port);
          if (Number.isInteger(port) && port > 0) {
            return { value: { port } };
          }
        }
        return { issues: [{ message: "port must be a positive integer", path: ["port"] }] };
      },
    },
  };
}

describe("ConfigProperties", () => {
  test("rejects prefixes outside dot-separated camelCase words", () => {
    const invalidPrefixes = [
      "",
      ".server",
      "Server",
      "server.",
      "server..http",
      "server.Http",
      "server_http",
      "1server",
    ];

    for (const prefix of invalidPrefixes) {
      expect(() => ConfigProperties(prefix, serverSchema())).toThrow(TypeError);
    }
  });

  test("accepts dot-separated camelCase prefixes", () => {
    const validPrefixes = ["server", "server.http", "app.mainDb", "s3", "retry2.maxCount"];

    for (const prefix of validPrefixes) {
      expect(() => ConfigProperties(prefix, serverSchema())).not.toThrow();
    }
  });

  test("rejects a second argument that is not a Standard Schema", () => {
    const invalidSchemas: unknown[] = [
      undefined,
      null,
      42,
      {},
      { "~standard": null },
      { "~standard": { version: 2, vendor: "x", validate: () => ({ value: {} }) } },
      { "~standard": { version: 1, vendor: "x" } },
    ];

    for (const schema of invalidSchemas) {
      // 负向用例刻意传入不合法 schema，绕过参数类型只能在测试里断言；运行期校验正是被测行为
      expect(() => ConfigProperties("server", schema as StandardSchemaV1<unknown, object>)).toThrow(
        TypeError,
      );
    }
  });

  test("direct construction assigns fields without running schema validation", () => {
    class ServerConfig extends ConfigProperties("server", serverSchema()) {}

    // -1 会被 schema 拒绝；直接 new 依旧赋值成功（ADR 0005 决策 1.2：同一构造器服务框架绑定与手工构造）
    const instance = new ServerConfig({ port: -1 });

    expect(instance.port).toBe(-1);
    expect(instance).toBeInstanceOf(ServerConfig);
  });

  test("metadata is readable from the subclass and frozen", () => {
    const schema = serverSchema();
    class ServerConfig extends ConfigProperties("server.http", schema) {}

    const metadata = readConfigPropertiesMetadata(ServerConfig);

    expect(metadata).toBeDefined();
    expect(metadata?.prefix).toBe("server.http");
    expect(metadata?.schema).toBe(schema);
    expect(Object.isFrozen(metadata)).toBe(true);
  });

  test("readConfigPropertiesMetadata returns undefined for plain classes", () => {
    class Unrelated {}

    expect(readConfigPropertiesMetadata(Unrelated)).toBeUndefined();
  });
});
