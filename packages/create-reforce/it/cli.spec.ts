import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runCreateReforce } from "@/cli";
import { validatePackageName } from "@/project-name";
import { withTemporaryDirectory } from "./support/temporary-directory";

// --yes 走非交互路径：不弹任何 prompt，缺的项取默认值。IT 全程用它驱动，不去伪造 TTY。
describe("runCreateReforce", () => {
  test("--yes 用默认引擎与默认目录名生成项目", async () => {
    await withTemporaryDirectory(async (cwd) => {
      const exitCode = await runCreateReforce({ argv: ["--yes"], cwd });

      expect(exitCode).toBe(0);
      expect(existsSync(join(cwd, "my-reforce-app", "package.json"))).toBe(true);
    });
  });

  test("位置参数决定目录，包名跟着目录走", async () => {
    await withTemporaryDirectory(async (cwd) => {
      const exitCode = await runCreateReforce({ argv: ["my-api", "--yes"], cwd });

      expect(exitCode).toBe(0);
      const parsed: unknown = JSON.parse(
        await readFile(join(cwd, "my-api", "package.json"), "utf8"),
      );
      expect(parsed).toHaveProperty("name", "my-api");
    });
  });

  test("嵌套相对路径按 cwd 解析", async () => {
    await withTemporaryDirectory(async (cwd) => {
      await mkdir(join(cwd, "workspace"));

      const exitCode = await runCreateReforce({ argv: ["workspace/api", "--yes"], cwd });

      expect(exitCode).toBe(0);
      expect(existsSync(join(cwd, "workspace", "api", "src", "application.ts"))).toBe(true);
    });
  });

  // 非交互下没人能确认"清空目录"这个决定，所以只能停下来——绝不默默删用户的文件。
  test("非交互遇到非空目录时拒绝生成，且不动已有文件", async () => {
    await withTemporaryDirectory(async (cwd) => {
      const target = join(cwd, "occupied");
      await mkdir(target);
      await writeFile(join(target, "keep-me.txt"), "original", "utf8");

      const exitCode = await runCreateReforce({ argv: ["occupied", "--yes"], cwd });

      expect(exitCode).toBe(1);
      await expect(readFile(join(target, "keep-me.txt"), "utf8")).resolves.toBe("original");
      expect(existsSync(join(target, "package.json"))).toBe(false);
    });
  });

  test("只含 .git 的目录按空处理——先 git init 再建项目是常规流程", async () => {
    await withTemporaryDirectory(async (cwd) => {
      const target = join(cwd, "prepared");
      await mkdir(join(target, ".git"), { recursive: true });

      const exitCode = await runCreateReforce({ argv: ["prepared", "--yes"], cwd });

      expect(exitCode).toBe(0);
      expect(existsSync(join(target, "package.json"))).toBe(true);
      expect(existsSync(join(target, ".git"))).toBe(true);
    });
  });

  test("目录名带尾斜杠时照常工作，包名不带斜杠", async () => {
    await withTemporaryDirectory(async (cwd) => {
      const exitCode = await runCreateReforce({ argv: ["my-api/", "--yes"], cwd });

      expect(exitCode).toBe(0);
      const parsed: unknown = JSON.parse(
        await readFile(join(cwd, "my-api", "package.json"), "utf8"),
      );
      expect(parsed).toHaveProperty("name", "my-api");
    });
  });

  // 目录名不合 npm 规范不是错误：目录照建，包名规范化后写进 package.json。
  test("非交互下不合法的目录名被规范化成包名，而不是报错", async () => {
    await withTemporaryDirectory(async (cwd) => {
      const exitCode = await runCreateReforce({ argv: ["My App", "--yes"], cwd });

      expect(exitCode).toBe(0);
      expect(existsSync(join(cwd, "My App", "package.json"))).toBe(true);
      const parsed: unknown = JSON.parse(
        await readFile(join(cwd, "My App", "package.json"), "utf8"),
      );
      expect(parsed).toHaveProperty("name", "my-app");
    });
  });

  test("路径中间被文件占住时报错退出，而不是抛未捕获异常", async () => {
    await withTemporaryDirectory(async (cwd) => {
      await writeFile(join(cwd, "blocker"), "", "utf8");

      const exitCode = await runCreateReforce({ argv: ["blocker/api", "--yes"], cwd });

      expect(exitCode).toBe(1);
    });
  });

  test("非法 --engine 以退出码 1 结束，不创建任何目录", async () => {
    await withTemporaryDirectory(async (cwd) => {
      const exitCode = await runCreateReforce({
        argv: ["my-api", "--engine", "express", "--yes"],
        cwd,
      });

      expect(exitCode).toBe(1);
      expect(existsSync(join(cwd, "my-api"))).toBe(false);
    });
  });

  // 不变量：目录名可以任意怪，写进 package.json 的 name 必须永远合法。
  test.each(["...", "My App", "_weird", "app@2"])(
    "目录名 %s 也能推出合法的 package.json name",
    async (directory) => {
      await withTemporaryDirectory(async (cwd) => {
        const exitCode = await runCreateReforce({ argv: [directory, "--yes"], cwd });

        expect(exitCode).toBe(0);
        const parsed: unknown = JSON.parse(
          await readFile(join(cwd, directory, "package.json"), "utf8"),
        );
        const name = (parsed as { readonly name: string }).name;
        expect(validatePackageName(name)).toBeUndefined();
      });
    },
  );

  test("--no-lint 生成的项目里没有 biome 配置", async () => {
    await withTemporaryDirectory(async (cwd) => {
      const exitCode = await runCreateReforce({ argv: ["my-api", "--no-lint", "--yes"], cwd });

      expect(exitCode).toBe(0);
      expect(existsSync(join(cwd, "my-api", "biome.jsonc"))).toBe(false);
    });
  });

  test("--help 以 0 退出且不创建目录", async () => {
    await withTemporaryDirectory(async (cwd) => {
      const exitCode = await runCreateReforce({ argv: ["my-api", "--help"], cwd });

      expect(exitCode).toBe(0);
      expect(existsSync(join(cwd, "my-api"))).toBe(false);
    });
  });

  test("生成的项目不含 node_modules——依赖由用户自己装", async () => {
    await withTemporaryDirectory(async (cwd) => {
      await runCreateReforce({ argv: ["my-api", "--yes"], cwd });

      expect(existsSync(join(cwd, "my-api", "node_modules"))).toBe(false);
    });
  });
});
