import { describe, expect, test } from "vitest";
import { configProvenanceRecords } from "@/binding/provenance";

function provenanceOf(
  entries: readonly (readonly [string, string])[],
): ReadonlyMap<string, string> {
  return new Map(entries);
}

describe("configProvenanceRecords", () => {
  test("counts the in-scope keys per layer", () => {
    const records = configProvenanceRecords({
      provenance: provenanceOf([
        ["SERVER_HOST", ".env"],
        ["SERVER_PORT", ".env.local"],
        ["SERVER_TIMEOUT", ".env"],
      ]),
      keyPrefixes: ["SERVER_"],
    });

    expect(records[0]?.fields).toMatchObject({
      keyCount: 3,
      layers: [
        { layer: ".env", keyCount: 2 },
        { layer: ".env.local", keyCount: 1 },
      ],
    });
  });

  // 环境里另外几百个变量与配置无关，全报出来等于没报。
  test("ignores keys outside every bound prefix", () => {
    const records = configProvenanceRecords({
      provenance: provenanceOf([
        ["SERVER_HOST", ".env"],
        ["PATH", "process-env"],
      ]),
      keyPrefixes: ["SERVER_"],
    });

    expect(records[0]?.fields.keyCount).toBe(1);
  });

  // 层的顺序即优先级顺序，与 loadEnvironmentSnapshot 的合并顺序一致。
  test("orders layers by the merge precedence rather than by discovery", () => {
    const records = configProvenanceRecords({
      provenance: provenanceOf([
        ["SERVER_A", "process-env"],
        ["SERVER_B", ".env"],
        ["SERVER_C", ".env.production"],
        ["SERVER_D", ".env.local"],
      ]),
      keyPrefixes: ["SERVER_"],
    });

    expect(records[0]?.fields.layers).toEqual([
      { layer: ".env", keyCount: 1 },
      { layer: ".env.local", keyCount: 1 },
      { layer: ".env.production", keyCount: 1 },
      { layer: "process-env", keyCount: 1 },
    ]);
  });

  // 明细恒发 debug（RFC 0011 L5 勘误）：绑定期没有任何配置面能回答「debug 开没开」，
  // 记录先进引导缓冲，重放时由真 logger 按用户的 LoggingSettings 过滤。
  test("names every key and its layer in the debug detail record", () => {
    const records = configProvenanceRecords({
      provenance: provenanceOf([
        ["SERVER_PORT", ".env.local"],
        ["SERVER_HOST", ".env"],
      ]),
      keyPrefixes: ["SERVER_"],
    });

    expect(records[1]?.level).toBe("debug");
    expect(records[1]?.fields.sources).toEqual([
      { key: "SERVER_HOST", layer: ".env" },
      { key: "SERVER_PORT", layer: ".env.local" },
    ]);
  });

  // 折叠必带出口（不变量 4），而且出口得是真能跑的手势——env 通道已撤，出口指向显式配置。
  test("points at the level that expands the summary", () => {
    const records = configProvenanceRecords({
      provenance: provenanceOf([["SERVER_HOST", ".env"]]),
      keyPrefixes: ["SERVER_"],
    });

    expect(records[0]?.fields.expandWith).toBe(
      'LoggingSettings.levels: { "reforce.config": "debug" }',
    );
  });

  // 脱敏铁律（ADR 0005 决策 6.2）：只出键名与层，永不出值。签名根本收不到 values map，
  // 这条用例钉的是没人绕过它——哨兵值在整份输出里一次都不出现。
  test("never carries a config value into the output", () => {
    const secret = "s3cr3t-sentinel-value";
    const records = configProvenanceRecords({
      provenance: provenanceOf([
        ["SERVER_HOST", ".env"],
        ["SERVER_PASSWORD", ".env.local"],
      ]),
      keyPrefixes: ["SERVER_"],
    });

    expect(JSON.stringify(records)).not.toContain(secret);
    expect(JSON.stringify(records)).toContain("SERVER_PASSWORD");
  });
});
