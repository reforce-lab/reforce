import { describe, expect, test } from "vitest";
import {
  isLoggerContract,
  loggerBeanId,
  loggingOriginId,
  redirectKey,
} from "@/analysis/logger-synthesis";
import type { LinkedSymbol } from "@/linking/model";

function symbol(input: { readonly name: string; readonly packageName?: string }): LinkedSymbol {
  return {
    key: `external:${input.name}`,
    kind: "interface",
    name: input.name,
    moduleSpecifier: "external/probe.ts",
    generic: false,
    ...(input.packageName === undefined
      ? {}
      : {
          external: {
            packageName: input.packageName,
            version: "1.0.0",
            packageRoot: `/packages/${input.packageName}`,
            coordinate: `${input.packageName}#${input.name}`,
          },
        }),
  };
}

describe("logger contract detection", () => {
  test("recognises the Logger contract from the logging package", () => {
    expect(isLoggerContract(symbol({ name: "Logger", packageName: loggingOriginId }))).toBe(true);
  });

  // 同名契约来自别的包时不能命中：否则用户自己的 Logger 接口会被框架接管。
  test("ignores a same-named contract from another package", () => {
    expect(isLoggerContract(symbol({ name: "Logger", packageName: "@acme/telemetry" }))).toBe(
      false,
    );
  });

  test("ignores the factory contract", () => {
    expect(isLoggerContract(symbol({ name: "LoggerFactory", packageName: loggingOriginId }))).toBe(
      false,
    );
  });

  test("ignores a local interface with no external attribution", () => {
    expect(isLoggerContract(symbol({ name: "Logger" }))).toBe(false);
  });
});

describe("logger bean identity", () => {
  test("carries the logger name inside the export segment of the id", () => {
    expect(loggerBeanId("orders")).toBe("@reforce/logging#Logger(orders)");
  });

  // 重定向表的键必须同时含消费者与参数位：同一个类可以有两个构造参数，其中只有一个是 Logger。
  test("keys a redirect by both the consumer and the parameter position", () => {
    expect(redirectKey("src/a.ts#A", 1)).not.toBe(redirectKey("src/a.ts#A", 0));
    expect(redirectKey("src/a.ts#A", 0)).not.toBe(redirectKey("src/b.ts#B", 0));
  });
});
