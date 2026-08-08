import { isReforceError } from "@reforce/core";
import { describe, expect, test } from "vitest";
import { ConfigProperties } from "@/config-properties";
import { configErrorCodes } from "@/error-codes";

// 本包此前一个码都没有：四处失败全是裸 TypeError（ADR 0013 决议 3，#292）。
function thrownBy(call: () => unknown): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  throw new Error("the call was expected to throw");
}

const schema = {
  "~standard": { version: 1 as const, vendor: "test", validate: () => ({ value: {} }) },
};

describe("ConfigProperties argument guards", () => {
  test("reports CONFIG_INVALID_PROPERTIES_PREFIX on a malformed prefix", () => {
    expect(thrownBy(() => ConfigProperties("Server_Http", schema as never))).toMatchObject({
      code: "CONFIG_INVALID_PROPERTIES_PREFIX",
    });
  });

  test("reports CONFIG_INVALID_PROPERTIES_SCHEMA on a non Standard Schema value", () => {
    expect(thrownBy(() => ConfigProperties("server.http", {} as never))).toMatchObject({
      code: "CONFIG_INVALID_PROPERTIES_SCHEMA",
    });
  });

  test("keeps a wrong argument type a TypeError", () => {
    expect(thrownBy(() => ConfigProperties("server.http", {} as never))).toBeInstanceOf(TypeError);
  });

  test("puts a wrong argument type into the lineage", () => {
    expect(isReforceError(thrownBy(() => ConfigProperties("server.http", {} as never)))).toBe(true);
  });

  test("carries a next step", () => {
    expect(thrownBy(() => ConfigProperties("Server_Http", schema as never))).toMatchObject({
      help: expect.stringContaining("camelCase"),
    });
  });
});

test("every config code carries the domain prefix", () => {
  expect(configErrorCodes.filter((code) => !code.startsWith("CONFIG_"))).toEqual([]);
});
