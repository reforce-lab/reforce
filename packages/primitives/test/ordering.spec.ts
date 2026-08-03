import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { compareUtf16CodeUnits } from "@/ordering";

describe("compareUtf16CodeUnits", () => {
  test("按 UTF-16 code unit 排序，而不是按 locale", () => {
    // 这三组是 code unit 与 localeCompare 结果相反的输入。任何人把实现换成
    // localeCompare / Intl.Collator / radashi 的 alphabetical，这里会立刻红。
    const pairs = [
      ["B", "a"],
      ["Z", "a"],
      ["Apple", "apple"],
    ] as const;

    const results = pairs.map(([left, right]) => Math.sign(compareUtf16CodeUnits(left, right)));

    expect(results).toEqual([-1, -1, -1]);
  });

  test("相同字符串返回 0", () => {
    const value = "packages/cli/src/reforce.ts";

    const result = compareUtf16CodeUnits(value, value);

    expect(result).toBe(0);
  });

  test("前缀排在被它前缀的字符串之前", () => {
    const result = compareUtf16CodeUnits("dev", "dev-runtime");

    expect(result).toBeLessThan(0);
  });

  test("空串排在任何非空串之前", () => {
    const result = compareUtf16CodeUnits("", "\0");

    expect(result).toBeLessThan(0);
  });

  test("代理对按高位 code unit 比较，而不是按 code point", () => {
    // "🍎" 的高代理是 \uD83C (55356)，小于 � (65533)；若改成按 code point 比较
    // (0x1F34E = 127822)，方向会翻转。
    const result = compareUtf16CodeUnits("\u{1F34E}", "�");

    expect(result).toBeLessThan(0);
  });

  test("反对称：交换两侧则符号取反", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (left, right) => {
        return (
          Math.sign(compareUtf16CodeUnits(left, right)) ===
          -Math.sign(compareUtf16CodeUnits(right, left))
        );
      }),
    );
  });

  test("传递性：构成全序，可安全用作 Array#sort 的 comparator", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.string(), (a, b, c) => {
        const ab = Math.sign(compareUtf16CodeUnits(a, b));
        const bc = Math.sign(compareUtf16CodeUnits(b, c));
        if (ab !== bc || ab === 0) {
          return true;
        }
        return Math.sign(compareUtf16CodeUnits(a, c)) === ab;
      }),
    );
  });

  test("排序结果与 JS 原生字符串比较一致", () => {
    fc.assert(
      fc.property(fc.array(fc.string()), (values) => {
        const actual = [...values].sort(compareUtf16CodeUnits);
        const expected = [...values].sort((left, right) => {
          if (left === right) {
            return 0;
          }
          return left < right ? -1 : 1;
        });
        return JSON.stringify(actual) === JSON.stringify(expected);
      }),
    );
  });
});
