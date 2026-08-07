import { describe, expect, test } from "vitest";
import { normalizeDirectoryInput } from "@/target-directory";

describe("normalizeDirectoryInput", () => {
  test("去掉首尾空白", () => {
    expect(normalizeDirectoryInput("  my-api  ")).toBe("my-api");
  });

  test("去掉尾部斜杠——shell 补全就会补出这个斜杠", () => {
    expect(normalizeDirectoryInput("my-api/")).toBe("my-api");
  });

  test("去掉多个尾部斜杠", () => {
    expect(normalizeDirectoryInput("my-api///")).toBe("my-api");
  });

  test("保留中间的路径分隔符", () => {
    expect(normalizeDirectoryInput("workspace/my-api")).toBe("workspace/my-api");
  });

  test("去掉 Windows 文件名非法字符", () => {
    expect(normalizeDirectoryInput('my<>:"|?*api')).toBe("myapi");
  });

  test("全是非法字符时归零，交给调用方判空", () => {
    expect(normalizeDirectoryInput("<>|")).toBe("");
  });
});
