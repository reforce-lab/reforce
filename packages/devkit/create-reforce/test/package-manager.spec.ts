import { describe, expect, test } from "vitest";
import { cdCommand, detectPackageManager, installCommand, runCommand } from "@/package-manager";

describe("detectPackageManager", () => {
  test.each([
    ["pnpm/11.20.0 npm/? node/v26.5.1 linux x64", "pnpm"],
    ["npm/11.0.0 node/v26.5.1 linux x64", "npm"],
    ["yarn/4.6.0 npm/? node/v26.5.1 linux x64", "yarn"],
    ["bun/1.2.0 npm/? node/v26.5.1 linux x64", "bun"],
    ["deno/2.1.0 npm/? node/v26.5.1 linux x64", "deno"],
  ])("认出 %s", (userAgent, expected) => {
    expect(detectPackageManager(userAgent)).toBe(expected);
  });

  test("没有 user agent 时退回 pnpm", () => {
    expect(detectPackageManager(undefined)).toBe("pnpm");
  });

  test("不认识的包管理器退回 pnpm，而不是原样透传", () => {
    expect(detectPackageManager("cnpm/9.0.0 node/v26.5.1")).toBe("pnpm");
  });

  test("空字符串退回 pnpm", () => {
    expect(detectPackageManager("")).toBe("pnpm");
  });
});

describe("installCommand", () => {
  test("yarn 装依赖不带 install 子命令", () => {
    expect(installCommand("yarn")).toBe("yarn");
  });

  test.each(["pnpm", "npm", "bun", "deno"] as const)("%s 用 install 子命令", (packageManager) => {
    expect(installCommand(packageManager)).toBe(`${packageManager} install`);
  });
});

describe("runCommand", () => {
  test("npm 必须走 run", () => {
    expect(runCommand("npm", "dev")).toBe("npm run dev");
  });

  test("deno 用 task 而不是 run", () => {
    expect(runCommand("deno", "dev")).toBe("deno task dev");
  });

  test.each(["pnpm", "yarn", "bun"] as const)("%s 直接跟脚本名", (packageManager) => {
    expect(runCommand(packageManager, "dev")).toBe(`${packageManager} dev`);
  });
});

describe("cdCommand", () => {
  test("普通路径不加引号", () => {
    expect(cdCommand("my-api")).toBe("cd my-api");
  });

  test("含空格的路径加引号，否则粘进终端会被拆成两个参数", () => {
    expect(cdCommand("my api")).toBe('cd "my api"');
  });
});
