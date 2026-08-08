import { isReforceError, ReforceError } from "@reforce/core";
import { describe, expect, test } from "vitest";
import { DirectoryTransactionError } from "@/project/directory-transaction";
import { ProjectBusyError } from "@/project/lease";
import { ArtifactInvalidError } from "@/start/artifact";

// CLI 子树并入统一谱系（ADR 0013 决议 1，#280）：此前这三个类各自 extends Error，reporter
// 认不出来，码全靠调用点把 error.code 手抄进 fallbackCode。
describe("the cli subtree joins the ReforceError lineage", () => {
  const cases = [
    ["ArtifactInvalidError", new ArtifactInvalidError("bad artifact"), "ARTIFACT_INVALID"],
    ["ProjectBusyError", new ProjectBusyError("/srv/app"), "PROJECT_BUSY"],
    [
      "DirectoryTransactionError",
      new DirectoryTransactionError("generated", "commit failed"),
      "GENERATED_TRANSACTION_FAILED",
    ],
  ] as const;

  for (const [name, error, code] of cases) {
    test(`${name} is recognized by the lineage guard`, () => {
      expect(isReforceError(error)).toBe(true);
    });

    test(`${name} is an instance of the shared root`, () => {
      expect(error).toBeInstanceOf(ReforceError);
    });

    test(`${name} carries its code`, () => {
      expect(error.code).toBe(code);
    });

    // name 由基类的 new.target.name 写入；诊断输出与崩溃日志按它认人。
    test(`${name} keeps its own class name`, () => {
      expect(error.name).toBe(name);
    });
  }

  test("DirectoryTransactionError still derives its code from the transaction kind", () => {
    expect(new DirectoryTransactionError("dist", "commit failed").code).toBe(
      "DIST_TRANSACTION_FAILED",
    );
  });
});
