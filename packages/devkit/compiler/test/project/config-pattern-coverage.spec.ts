import path from "node:path";
import type { TsConfigJsonResolved } from "get-tsconfig";
import { describe, expect, test } from "vitest";
import { generatedOutputIsIncluded } from "@/project/config-pattern-coverage";

const tsconfigPath = path.join(path.parse(process.cwd()).root, "reforce-app", "tsconfig.json");

function isIncluded(config: TsConfigJsonResolved): boolean {
  return generatedOutputIsIncluded(config, tsconfigPath);
}

describe("generated output coverage", () => {
  test("reports a config without include or files as not covering the generated output", () => {
    const covered = isIncluded({});

    expect(covered).toBe(false);
  });

  test("reports wildcard includes as not covering the dotted generated directory", () => {
    // tsc expands a wildcard segment so that it never starts with a dot, so none of these reach
    // `.reforce/` even though a plain glob matcher would say otherwise (Issue #60).
    const recursive = isIncluded({ include: ["**/*"] });
    const projectDirectory = isIncluded({ include: ["."] });

    expect(recursive).toBe(false);
    expect(projectDirectory).toBe(false);
  });

  test("reports a declaration-only include as not covering the emitted modules", () => {
    // 生成物的另一半是普通 .ts（beans.ts 里 emit 的 `new Target(...)`）；只收 .d.ts 时它不进
    // 用户的编译单元，整类 emission 缺陷要拖到运行期才现形（#350）。
    const covered = isIncluded({ include: ["src", ".reforce/generated/**/*.d.ts"] });

    expect(covered).toBe(false);
  });

  test("reports an include that names the generated directory as covering the output", () => {
    const covered = isIncluded({ include: ["src", ".reforce/generated/**/*.ts"] });

    expect(covered).toBe(true);
  });

  test("reports a files entry that names both generated halves as covering them", () => {
    const covered = isIncluded({
      files: [
        "src/application.ts",
        ".reforce/generated/qualifiers.d.ts",
        ".reforce/generated/beans.ts",
      ],
    });

    expect(covered).toBe(true);
  });

  test("reports a files-only config that omits the generated output as not covering it", () => {
    const covered = isIncluded({ files: ["src/application.ts"] });

    expect(covered).toBe(false);
  });

  test("reports an exclude over the generated directory as removing the output", () => {
    const covered = isIncluded({
      include: ["src", ".reforce/generated/**/*.ts"],
      exclude: [".reforce"],
    });

    expect(covered).toBe(false);
  });

  test("reports an unrelated internal output include as not covering the generated output", () => {
    const covered = isIncluded({ include: ["src", ".reforce/internal"] });

    expect(covered).toBe(false);
  });
});

// A UNC config path reaches this module as "//host/share/..." once the native separators are
// portable, which is the shape Windows produces and the shape these cases feed in directly, so
// the matching arithmetic is covered on every runner.
describe("generated output coverage across a UNC boundary", () => {
  const uncConfigPath = "//localhost/C$/work/application/tsconfig.json";

  function isIncludedOnShare(config: TsConfigJsonResolved): boolean {
    return generatedOutputIsIncluded(config, uncConfigPath);
  }

  test("reports an include that names the generated directory as covering the output", () => {
    const covered = isIncludedOnShare({ include: ["src", ".reforce/generated/**/*.ts"] });

    expect(covered).toBe(true);
  });

  test("reports a files entry that names both generated halves as covering them", () => {
    const covered = isIncludedOnShare({
      files: [
        "src/application.ts",
        ".reforce/generated/qualifiers.d.ts",
        ".reforce/generated/beans.ts",
      ],
    });

    expect(covered).toBe(true);
  });

  test("reports wildcard includes as not covering the dotted generated directory", () => {
    const covered = isIncludedOnShare({ include: ["**/*"] });

    expect(covered).toBe(false);
  });
});
