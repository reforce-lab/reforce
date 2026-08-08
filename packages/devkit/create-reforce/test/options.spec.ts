import { describe, expect, test } from "vitest";
import { parseCliOptions, UsageError } from "@/options";

describe("parseCliOptions", () => {
  test("空参数下三项都不表态，留给交互问", () => {
    const options = parseCliOptions([]);

    expect(options.directory).toBeUndefined();
    expect(options.engine).toBeUndefined();
    expect(options.lint).toBeUndefined();
  });

  test("位置参数读作目标目录", () => {
    const options = parseCliOptions(["my-api"]);

    expect(options.directory).toBe("my-api");
  });

  test("第二个位置参数被拒绝，而不是静默丢弃", () => {
    expect(() => parseCliOptions(["a", "b"])).toThrow(UsageError);
  });

  test("未知选项被拒绝", () => {
    expect(() => parseCliOptions(["--nope"])).toThrow(UsageError);
  });

  test("非法 --engine 的报错列出可选值", () => {
    expect(() => parseCliOptions(["--engine", "express"])).toThrow(/hono/);
  });

  test.each(["hono", "fastify", "node"])("--engine %s 被接受", (engine) => {
    expect(parseCliOptions(["--engine", engine]).engine).toBe(engine);
  });

  test("--lint 表态为 true", () => {
    expect(parseCliOptions(["--lint"]).lint).toBe(true);
  });

  test("--no-lint 表态为 false", () => {
    expect(parseCliOptions(["--no-lint"]).lint).toBe(false);
  });

  test("--lint 与 --no-lint 同时给出被拒绝，而不是任选其一", () => {
    expect(() => parseCliOptions(["--lint", "--no-lint"])).toThrow(UsageError);
  });

  test("-y 是 --yes 的短写", () => {
    expect(parseCliOptions(["-y"]).yes).toBe(true);
  });

  test("--help 与目录可以并存，由调用方决定优先级", () => {
    const options = parseCliOptions(["my-api", "--help"]);

    expect(options.help).toBe(true);
    expect(options.directory).toBe("my-api");
  });
});
