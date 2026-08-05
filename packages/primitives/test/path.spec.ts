import path, { posix, sep, win32 } from "node:path";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  isPathContained,
  isPathStrictlyContained,
  isRelativePosixPath,
  toPortablePath,
} from "@/path";

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

// 段里排除分隔符、`.` 和 `..`，是为了让 boundary 与 target 的拼接结果可预测；本组用例要验证的是
// 包含判定本身，不是 path.normalize 的折叠规则。
const pathSegment = fc
  .string({ minLength: 1, maxLength: 12 })
  .filter((value) => !value.includes("/") && value !== "." && value !== "..");

const absolutePosixPath = fc
  .array(pathSegment, { maxLength: 5 })
  .map((segments) => `/${segments.join("/")}`);

describe("isPathContained", () => {
  test("默认使用当前平台语义，且不因空格或非 ASCII 段失效", () => {
    const boundary = path.join(path.parse(process.cwd()).root, "Reforce Projects", "应用");
    const child = path.join(boundary, "source files", "服务.ts");

    const contained = isPathContained(boundary, child);

    expect(contained).toBe(true);
  });

  test("boundary 自身算在边界内", () => {
    const boundary = "C:\\Reforce Projects\\应用";

    const contained = isPathContained(boundary, boundary, win32);

    expect(contained).toBe(true);
  });

  test("同盘符下的子路径在边界内", () => {
    const boundary = "C:\\Reforce Projects\\应用";

    const contained = isPathContained(
      boundary,
      "C:\\Reforce Projects\\应用\\source files\\服务.ts",
      win32,
    );

    expect(contained).toBe(true);
  });

  test("拒绝同名前缀的兄弟目录、上跳路径和跨盘符目标", () => {
    const boundary = "C:\\work\\application";

    const sibling = isPathContained(boundary, "C:\\work\\application-copy", win32);
    const escaped = isPathContained(boundary, "C:\\work\\application\\..\\outside", win32);
    const crossDrive = isPathContained(boundary, "D:\\work\\application\\src", win32);

    expect(sibling).toBe(false);
    expect(escaped).toBe(false);
    expect(crossDrive).toBe(false);
  });

  test("同一 UNC 共享下的子路径在边界内", () => {
    const boundary = "\\\\server\\shared apps\\应用";

    const contained = isPathContained(
      boundary,
      "\\\\server\\shared apps\\应用\\source files\\服务.ts",
      win32,
    );

    expect(contained).toBe(true);
  });

  test("拒绝 UNC 上跳路径以及另一个共享或另一台服务器上的目标", () => {
    const boundary = "\\\\server\\shared\\application";

    const escaped = isPathContained(
      boundary,
      "\\\\server\\shared\\application\\..\\outside",
      win32,
    );
    const crossShare = isPathContained(boundary, "\\\\server\\other-share\\application", win32);
    const crossServer = isPathContained(boundary, "\\\\other-server\\shared\\application", win32);

    expect(escaped).toBe(false);
    expect(crossShare).toBe(false);
    expect(crossServer).toBe(false);
  });
});

describe("isPathStrictlyContained", () => {
  test("boundary 自身算越界", () => {
    const boundary = "/work/application";

    const contained = isPathStrictlyContained(boundary, boundary, posix);

    expect(contained).toBe(false);
  });

  test("子路径仍在边界内", () => {
    const boundary = "/work/application";

    const contained = isPathStrictlyContained(boundary, "/work/application/dist", posix);

    expect(contained).toBe(true);
  });

  test("跨盘符目标越界", () => {
    const contained = isPathStrictlyContained("C:\\work\\application", "D:\\work", win32);

    expect(contained).toBe(false);
  });
});

describe("两个包含判定变体的关系", () => {
  test("严格变体为真时含自身变体必然为真", () => {
    fc.assert(
      fc.property(absolutePosixPath, absolutePosixPath, (boundary, target) => {
        if (!isPathStrictlyContained(boundary, target, posix)) {
          return true;
        }
        return isPathContained(boundary, target, posix);
      }),
    );
  });

  test("boundary 自身在含自身变体为真、在严格变体为假", () => {
    fc.assert(
      fc.property(
        absolutePosixPath,
        (boundary) =>
          isPathContained(boundary, boundary, posix) &&
          !isPathStrictlyContained(boundary, boundary, posix),
      ),
    );
  });

  test("非空后代路径在两个变体下都为真", () => {
    fc.assert(
      fc.property(
        absolutePosixPath,
        fc.array(pathSegment, { minLength: 1, maxLength: 5 }),
        (boundary, descendantSegments) => {
          const target = posix.join(boundary, ...descendantSegments);
          return (
            isPathContained(boundary, target, posix) &&
            isPathStrictlyContained(boundary, target, posix)
          );
        },
      ),
    );
  });
});

describe("isRelativePosixPath", () => {
  test("空串不是相对 POSIX 路径", () => {
    expect(isRelativePosixPath("")).toBe(false);
  });

  test("POSIX 绝对路径被拒绝", () => {
    expect(isRelativePosixPath("/etc/passwd")).toBe(false);
  });

  test("Windows 盘符前缀被拒绝", () => {
    expect(isRelativePosixPath("C:/main.mjs")).toBe(false);
  });

  test("反斜杠被拒绝", () => {
    expect(isRelativePosixPath("dist\\main.mjs")).toBe(false);
  });

  test("NUL 字符被拒绝", () => {
    expect(isRelativePosixPath("dist/main.mjs\0.txt")).toBe(false);
  });

  test("上跳段被拒绝", () => {
    expect(isRelativePosixPath("dist/../../etc/passwd")).toBe(false);
  });

  test("当前目录段被拒绝", () => {
    expect(isRelativePosixPath("dist/./main.mjs")).toBe(false);
  });

  test("空段（连续分隔符）被拒绝", () => {
    expect(isRelativePosixPath("dist//main.mjs")).toBe(false);
  });

  test("尾随分隔符被拒绝", () => {
    expect(isRelativePosixPath("dist/")).toBe(false);
  });

  test("单段相对路径被接受", () => {
    expect(isRelativePosixPath("main.mjs")).toBe(true);
  });

  test("多段相对路径被接受", () => {
    expect(isRelativePosixPath("static/js/main.abc123.mjs")).toBe(true);
  });

  test("由合法段拼出的路径一律被接受", () => {
    // 这里不能复用 pathSegment：它只排除了 `/`、`.` 和 `..`，仍会生成含反斜杠、NUL 或盘符前缀的段，
    // 而那些正是本函数要拒绝的输入。
    const portableSegment = fc
      .array(fc.constantFrom("a", "z", "0", "9", "-", "_", "应"), { minLength: 1, maxLength: 12 })
      .map((characters) => characters.join(""));

    fc.assert(
      fc.property(fc.array(portableSegment, { minLength: 1, maxLength: 6 }), (segments) =>
        isRelativePosixPath(segments.join("/")),
      ),
    );
  });
});
