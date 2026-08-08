import path from "node:path";
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

  test("剥掉 UNC pattern 前面那截合成的 ./，双斜杠原样留下", () => {
    const normalized = normalizePattern(".///localhost/c$/app/src", onWindows);

    expect(normalized).toBe("//localhost/c$/app/src");
  });

  test("剥完的 UNC pattern 经 path.resolve 仍落在原 share 上", () => {
    // 这条钉的是缺陷的后果而不是字符串本身：多留一条斜杠时 path.win32.resolve 不再把它当 UNC 根，
    // `///localhost/c$/…` 会被重解释成项目所在盘上的路径，跨 share 的源文件因此被误判成落在项目根内
    // （Issue #390）。`files` 条目走的正是这条 resolve。
    const resolved = path.win32.resolve(
      "C:\\app",
      normalizePattern(".///localhost/c$/app/src/external.ts", onWindows),
    );

    expect(resolved).toBe("\\\\localhost\\c$\\app\\src\\external.ts");
  });

  test("win32 语义下不碰普通的相对 pattern", () => {
    const normalized = normalizePattern("./src/**/*.ts", onWindows);

    expect(normalized).toBe("./src/**/*.ts");
  });

  test("POSIX 语义下保留 .///，因为剥掉前缀会把它变成绝对路径", () => {
    // `.///foo` 是相对路径，`/foo` 不是——这就是 win32 那条改写必须走注入而不能拉直的理由。
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
