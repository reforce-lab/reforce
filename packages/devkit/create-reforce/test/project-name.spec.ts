import { describe, expect, test } from "vitest";
import { packageNameFromDirectory, toValidPackageName, validatePackageName } from "@/project-name";

describe("packageNameFromDirectory", () => {
  test("取路径最后一段作为包名", () => {
    expect(packageNameFromDirectory("some/nested/my-api", "/work")).toBe("my-api");
  });

  test('"." 解析成 cwd 的目录名，而不是留着一个点', () => {
    expect(packageNameFromDirectory(".", "/work/my-api")).toBe("my-api");
  });

  test("相对路径按传入的 cwd 解析，不落到进程当前目录", () => {
    expect(packageNameFromDirectory("api", "/work/outer")).toBe("api");
  });
});

describe("validatePackageName", () => {
  test("常规小写短横名合法", () => {
    expect(validatePackageName("my-api")).toBeUndefined();
  });

  test("scope 名合法", () => {
    expect(validatePackageName("@acme/my-api")).toBeUndefined();
  });

  test("空名被拒绝", () => {
    expect(validatePackageName("")).toBeDefined();
  });

  test("大写被拒绝", () => {
    expect(validatePackageName("MyApi")).toBeDefined();
  });

  test("空格被拒绝", () => {
    expect(validatePackageName("my api")).toBeDefined();
  });

  test("以点开头被拒绝", () => {
    expect(validatePackageName(".my-api")).toBeDefined();
  });

  test("以下划线开头被拒绝", () => {
    expect(validatePackageName("_my-api")).toBeDefined();
  });

  test("超过 214 字符被拒绝", () => {
    expect(validatePackageName("a".repeat(215))).toBeDefined();
  });
});

// 规范化的意义：目录叫 "My App" 不是用户的错，只有 package.json 里那个名字要守 npm 规则。
describe("toValidPackageName", () => {
  test("大写转小写", () => {
    expect(toValidPackageName("MyApi")).toBe("myapi");
  });

  test("空格转连字符", () => {
    expect(toValidPackageName("my api")).toBe("my-api");
  });

  test("连续空格压成一个连字符", () => {
    expect(toValidPackageName("my   api")).toBe("my-api");
  });

  test("去掉开头的点", () => {
    expect(toValidPackageName(".my-api")).toBe("my-api");
  });

  test("去掉开头的下划线", () => {
    expect(toValidPackageName("_my-api")).toBe("my-api");
  });

  test("其余非法字符转连字符", () => {
    expect(toValidPackageName("my@api!")).toBe("my-api-");
  });

  test.each(["My App", "_weird Name", "Foo.Bar Baz"])("%s 规范化后是合法包名", (input) => {
    expect(validatePackageName(toValidPackageName(input))).toBeUndefined();
  });
});
