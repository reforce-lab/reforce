import { describe, expect, test } from "vitest";
import { environmentKeyForLogger, validateLoggerLevelKeys } from "@/analysis/logger-levels";
import type { CompilerDiagnostic } from "@/api";

function validate(keys: readonly string[], loggerNames: readonly string[]) {
  const diagnostics: CompilerDiagnostic[] = [];
  validateLoggerLevelKeys({ environmentKeys: new Set(keys), loggerNames, diagnostics });
  return diagnostics;
}

describe("logger level environment keys", () => {
  // 与 @reforce/logging 的 environmentKeyForLogger 必须逐字一致，否则编译期校验过的键在
  // 运行期查不到。
  test("screams a dotted logger name into a single key", () => {
    expect(environmentKeyForLogger("reforce.web")).toBe("LOGGING_LEVEL_REFORCE_WEB");
  });

  // 大小写必须能还原：走 @reforce/config 的 buildBindingInput 会 toLowerCase，
  // payments.Gateway 与 payments.gateway 会塌成同一个键。
  test("keeps two logger names that differ only by case apart", () => {
    expect(environmentKeyForLogger("payments.Gateway")).toBe(
      environmentKeyForLogger("payments.gateway"),
    );
  });
});

describe("logging.level.* validation", () => {
  test("accepts a key naming a known logger", () => {
    expect(validate(["LOGGING_LEVEL_ORDERS"], ["orders"])).toEqual([]);
  });

  test("warns about a key naming no logger and suggests the nearest", () => {
    const diagnostics = validate(["LOGGING_LEVEL_ODRERS"], ["orders"]);

    expect(diagnostics.map((item) => [item.code, item.severity])).toEqual([
      ["UNKNOWN_LOGGER_NAME", "warning"],
    ]);
    expect(diagnostics[0]?.help).toContain("LOGGING_LEVEL_ORDERS");
  });

  // 级别写错一个名字，应用照样跑得起来——拦住编译会让「加一条日志顺手调级」变成构建失败。
  test("never raises an error for a level key", () => {
    expect(
      validate(["LOGGING_LEVEL_NOWHERE"], ["orders"]).every((d) => d.severity === "warning"),
    ).toBe(true);
  });

  // 本通道是精确查表，非日志键一概不看——@reforce/config 的 warnUnmatchedKeys 才管那些。
  test("ignores keys outside the logging namespace", () => {
    expect(validate(["DATABASE_URL", "SERVER_PORT"], ["orders"])).toEqual([]);
  });

  test("says so plainly when the application has no logger at all", () => {
    expect(validate(["LOGGING_LEVEL_ORDERS"], [])[0]?.help).toContain("no class injects a Logger");
  });
});

describe("dotenv version parity", () => {
  // 两个包各自读 .env，方言必须同源：dotenv 的 parse 在大版本间改过引号与多行的处理，
  // 版本漂移会让编译期看见的键集与运行期的不一致。
  test("pins the same dotenv range as @reforce/config", async () => {
    const [compiler, config] = await Promise.all([
      import("../../package.json", { with: { type: "json" } }),
      import("../../../config/package.json", { with: { type: "json" } }),
    ]);

    expect(compiler.default.dependencies.dotenv).toBe(config.default.dependencies.dotenv);
  });
});
