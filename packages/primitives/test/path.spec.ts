import { describe, expect, test } from "bun:test";
import { sep } from "node:path";
import { toPortablePath } from "@/path";

describe("toPortablePath", () => {
  test("把注入的 Windows 分隔符换成 POSIX 分隔符", () => {
    const result = toPortablePath("packages\\cli\\src\\reforce.ts", "\\");

    expect(result).toBe("packages/cli/src/reforce.ts");
  });

  test("POSIX 分隔符下是恒等变换", () => {
    const result = toPortablePath("packages/cli/src/reforce.ts", "/");

    expect(result).toBe("packages/cli/src/reforce.ts");
  });

  test("Windows 盘符路径保留盘符段", () => {
    const result = toPortablePath("C:\\workspace\\app\\dist", "\\");

    expect(result).toBe("C:/workspace/app/dist");
  });

  test("不含分隔符的单段路径原样返回", () => {
    const result = toPortablePath("reforce.ts", "\\");

    expect(result).toBe("reforce.ts");
  });

  test("空串原样返回", () => {
    const result = toPortablePath("", "\\");

    expect(result).toBe("");
  });

  test("Windows 语义下不动已经是 POSIX 分隔符的片段", () => {
    // 反斜杠平台上正斜杠本来就是合法分隔符，这个函数只负责归一，不负责校验。
    const result = toPortablePath("a/b\\c", "\\");

    expect(result).toBe("a/b/c");
  });

  test("缺省分隔符跟随当前平台", () => {
    const result = toPortablePath(["a", "b"].join(sep));

    expect(result).toBe("a/b");
  });
});
