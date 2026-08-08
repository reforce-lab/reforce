import { describe, expect, test } from "vitest";
import { normalizePattern } from "@/project/config-file-discovery";

const onWindows = { windows: true } as const;
const onPosix = { windows: false } as const;

describe("normalizePattern", () => {
  test("把反斜杠归一成正斜杠，好让 glob matcher 认得", () => {
    const normalized = normalizePattern("src\\**\\*.ts", onWindows);

    expect(normalized).toBe("src/**/*.ts");
  });

  test("剥掉 win32 绝对 pattern 前面那截合成的 ./", () => {
    // tsconfig 里的绝对路径在 win32 上会以 "./C:/..." 的形态浮上来，带着它去匹配永远匹配不上。
    const normalized = normalizePattern(".\\C:\\workspace\\app\\src\\external.ts", onWindows);

    expect(normalized).toBe("C:/workspace/app/src/external.ts");
  });

  test("剥掉 UNC pattern 前面那个合成的点", () => {
    // 这条钉的是**现状**，不是「应该」：盘符分支切 2 个字符（连 `./` 一起去掉），UNC 分支只切 1 个，
    // 于是 UNC 前缀留下三条斜杠而不是两条。这个分支在 Windows runner 上也没有证据——现有两条
    // Windows IT 走的都是相对 files 与盘符形态，从没进过这里。要动它得先有真实 get-tsconfig
    // 输出作依据（Issue #381 交付说明已记）。
    const normalized = normalizePattern(".///localhost/c$/app/src", onWindows);

    expect(normalized).toBe("///localhost/c$/app/src");
  });

  test("win32 语义下不碰普通的相对 pattern", () => {
    const normalized = normalizePattern("./src/**/*.ts", onWindows);

    expect(normalized).toBe("./src/**/*.ts");
  });

  test("POSIX 语义下保留 .///，因为切掉首字符会把它变成绝对路径", () => {
    // `.///foo` 是相对路径，`//foo` 不是——这就是 win32 那两条改写必须走注入而不能拉直的理由。
    const normalized = normalizePattern(".///foo", onPosix);

    expect(normalized).toBe(".///foo");
  });

  test("POSIX 语义下保留 ./ 前缀的盘符形状", () => {
    // POSIX 上 "C:" 只是个普通目录名，剥掉 "./" 会把相对 pattern 变成另一个 pattern。
    const normalized = normalizePattern("./C:/workspace", onPosix);

    expect(normalized).toBe("./C:/workspace");
  });

  test("缺省的平台形态跟随当前平台", () => {
    const normalized = normalizePattern("./C:/workspace");

    expect(normalized).toBe(process.platform === "win32" ? "C:/workspace" : "./C:/workspace");
  });
});
