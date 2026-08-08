import { coreErrorCodes } from "@reforce/core";
import { webErrorCodes } from "@reforce/web";
import { describe, expect, test } from "vitest";
import { diagnosticArticle } from "@/explain/codes";
import { runtimeArticles } from "@/explain/runtime-articles";

// 容器/管线运行期长文表（#297 收口批）。断言的是表的归属边界与查找链路，不是文风；全量覆盖、
// 键合法性与行宽由 codes.spec 对五张表统一断言。

describe("runtime articles table ownership", () => {
  // 本表只收两组存量码：core 的无前缀运行时码（CONFIG_BINDING_FAILED 例外，它按决议 5 先补在
  // argument-articles，#293）与 web 的无前缀管线码。CORE_/WEB_ 前缀码属于 argument-articles。
  test("carries exactly the legacy core runtime and web pipeline codes", () => {
    const expected = [
      ...coreErrorCodes.filter(
        (code) => !code.startsWith("CORE_") && code !== "CONFIG_BINDING_FAILED",
      ),
      ...webErrorCodes.filter((code) => !code.startsWith("WEB_")),
    ].sort();

    expect(Object.keys(runtimeArticles).sort()).toEqual(expected);
  });

  test("resolves a core lifecycle article through the merged lookup", () => {
    expect(diagnosticArticle("REQUEST_CONTEXT_MISSING")?.summary).toContain("request scope");
  });

  test("resolves a web pipeline article through the merged lookup", () => {
    expect(diagnosticArticle("INVALID_ROUTE_TABLE")?.summary).toContain("route table");
  });
});
