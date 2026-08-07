import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ENGINES } from "@/engines";
import type { ProjectSpec } from "@/project/package-json";
import { scaffoldProject } from "@/project/scaffold";
import { withTemporaryDirectory } from "./support/temporary-directory";

function specOf(overrides: Partial<ProjectSpec> = {}): ProjectSpec {
  return { name: "my-api", engine: "hono", lint: true, ...overrides };
}

// 清理逻辑只在拷贝中途失败时才跑，而唯一不依赖平台权限、又稳定可复现的失败源就是
// "模板层目录不存在"。构造它需要一个越过 EngineKey 的值——断言只此一处，被测的是
// scaffoldProject 的失败清理，不是类型系统。
function specWithMissingTemplateLayer(): ProjectSpec {
  return { ...specOf(), engine: "nonexistent" as ProjectSpec["engine"] };
}

async function readGenerated(root: string, file: string): Promise<string> {
  return await readFile(join(root, file), "utf8");
}

// 模板里的 schema 组：`export const showGreeting = { ... } as const;`。先框出组体再取槽位，
// 不能直接全文扫「槽位: 标识符」——dto 里还有 `query: PaginationQuery` 这类函数形参标注，
// 长得一模一样但不是路由 schema。
const SCHEMA_GROUP_BODY = /=\s*\{([^}]*)\}\s*as const/g;
const SCHEMA_SLOT_REFERENCE = /(?:params|query|body|response):\s*([A-Za-z_$][\w$]*)/g;

const CONTROLLER = "src/features/greeting/greeting.controller.ts";
const DTO = "src/features/greeting/greeting.dto.ts";

describe("scaffoldProject", () => {
  test("目标目录不存在时创建它并写出项目", async () => {
    await withTemporaryDirectory(async (root) => {
      const target = join(root, "my-api");

      const result = await scaffoldProject(target, specOf());

      expect(result.files).toContain("package.json");
      expect(result.files).toContain("src/application.ts");
    });
  });

  test("模板里的 gitignore 落盘为 .gitignore——npm pack 会吞点号版本", async () => {
    await withTemporaryDirectory(async (root) => {
      const target = join(root, "my-api");

      const result = await scaffoldProject(target, specOf());

      expect(result.files).toContain(".gitignore");
      expect(result.files).not.toContain("gitignore");
      await expect(readGenerated(target, ".gitignore")).resolves.toContain("node_modules");
    });
  });

  test.each(["hono", "fastify", "node"] as const)(
    "engine %s 的 application.ts 引用对应的 starter",
    async (engine) => {
      await withTemporaryDirectory(async (root) => {
        const target = join(root, "my-api");

        await scaffoldProject(target, specOf({ engine }));

        const application = await readGenerated(target, "src/application.ts");
        // starter 注册 handle 是主入口的具名导出 `web`（#244），不是子路径导入。
        expect(application).toContain(`import { web } from "${ENGINES[engine].packageName}"`);
      });
    },
  );

  test.each(["hono", "fastify", "node"] as const)(
    "engine %s 的 web-server.config.ts 闭合对应的 ServeSettings 契约",
    async (engine) => {
      await withTemporaryDirectory(async (root) => {
        const target = join(root, "my-api");

        await scaffoldProject(target, specOf({ engine }));

        const config = await readGenerated(target, "src/config/web-server.config.ts");
        expect(config).toContain(`from "${ENGINES[engine].packageName}"`);
      });
    },
  );

  test("引擎无关的文件不随引擎变化", async () => {
    await withTemporaryDirectory(async (root) => {
      const hono = join(root, "hono-app");
      const fastify = join(root, "fastify-app");

      await scaffoldProject(hono, specOf({ engine: "hono" }));
      await scaffoldProject(fastify, specOf({ engine: "fastify" }));

      await expect(readGenerated(hono, CONTROLLER)).resolves.toBe(
        await readGenerated(fastify, CONTROLLER),
      );
    });
  });

  // 目录分层是模板对用户的主要引导（features / infrastructure / shared / config）。它没有
  // 任何编译期约束兜底——挪错地方照样能跑——所以只能在这里钉住，免得日后随手改乱。
  test("模板铺出 config / features / infrastructure / shared 四层", async () => {
    await withTemporaryDirectory(async (root) => {
      const target = join(root, "my-api");

      const result = await scaffoldProject(target, specOf());

      expect(result.files).toEqual(
        expect.arrayContaining([
          "src/application.ts",
          "src/config/app.config.ts",
          "src/config/web-server.config.ts",
          CONTROLLER,
          DTO,
          "src/features/greeting/greeting.exception.ts",
          "src/features/greeting/greeting.service.ts",
          "src/features/health/health.controller.ts",
          "src/infrastructure/persistence/in-memory-greeting.store.ts",
          "src/infrastructure/web/api-key.middleware.ts",
          "src/infrastructure/web/fallback-error.handler.ts",
          "src/infrastructure/web/http-error.handler.ts",
          "src/infrastructure/web/request-logging.middleware.ts",
          "src/shared/http/not-found.exception.ts",
          "src/shared/pagination/pagination.dto.ts",
          "src/shared/pagination/sort-order.enum.ts",
        ]),
      );
    });
  });

  // `<名字>.<种类>.ts` 是模板要传达的约定本身，而 application.ts 是入口、不带种类后缀。
  // 框架不认这个后缀，写错了照样能跑，所以只能在这里钉住。
  test("src 下除入口外的每个文件都是 <名字>.<种类>.ts", async () => {
    await withTemporaryDirectory(async (root) => {
      const target = join(root, "my-api");

      const result = await scaffoldProject(target, specOf());

      const sources = result.files.filter(
        (file) => file.startsWith("src/") && file !== "src/application.ts",
      );
      expect(sources.length).toBeGreaterThan(0);
      for (const file of sources) {
        expect(file).toMatch(/\/[a-z0-9-]+\.[a-z]+\.ts$/);
      }
    });
  });

  test("lint 打开时写出 biome.jsonc", async () => {
    await withTemporaryDirectory(async (root) => {
      const target = join(root, "my-api");

      const result = await scaffoldProject(target, specOf({ lint: true }));

      expect(result.files).toContain("biome.jsonc");
    });
  });

  test("lint 关闭时不写 biome.jsonc", async () => {
    await withTemporaryDirectory(async (root) => {
      const target = join(root, "my-api");

      const result = await scaffoldProject(target, specOf({ lint: false }));

      expect(result.files).not.toContain("biome.jsonc");
    });
  });

  test("生成的 package.json 用 spec 里的项目名", async () => {
    await withTemporaryDirectory(async (root) => {
      const target = join(root, "whatever-directory");

      await scaffoldProject(target, specOf({ name: "chosen-name" }));

      const parsed: unknown = JSON.parse(await readGenerated(target, "package.json"));
      expect(parsed).toHaveProperty("name", "chosen-name");
    });
  });

  test("用户预先建好的空目录被沿用，不报错", async () => {
    await withTemporaryDirectory(async (root) => {
      const target = join(root, "prepared");
      await mkdir(target);

      const result = await scaffoldProject(target, specOf());

      expect(result.files).toContain("package.json");
    });
  });

  test("拷贝中途失败时，自己创建的目录被整棵删除，不留半个项目", async () => {
    await withTemporaryDirectory(async (root) => {
      const target = join(root, "doomed");

      await expect(scaffoldProject(target, specWithMissingTemplateLayer())).rejects.toThrow();

      expect(existsSync(target)).toBe(false);
    });
  });

  test("失败发生在用户自己建的目录里时，不删除该目录", async () => {
    await withTemporaryDirectory(async (root) => {
      const target = join(root, "users-own");
      await mkdir(target);

      await expect(scaffoldProject(target, specWithMissingTemplateLayer())).rejects.toThrow();

      expect(existsSync(target)).toBe(true);
    });
  });

  test('existingFiles="remove" 清空目录但保留 .git——删掉它就是删用户的提交历史', async () => {
    await withTemporaryDirectory(async (root) => {
      const target = join(root, "occupied");
      await mkdir(join(target, ".git"), { recursive: true });
      await writeFile(join(target, ".git", "HEAD"), "ref: refs/heads/main", "utf8");
      await writeFile(join(target, "stale.txt"), "old", "utf8");

      await scaffoldProject(target, specOf(), "remove");

      expect(existsSync(join(target, "stale.txt"))).toBe(false);
      await expect(readFile(join(target, ".git", "HEAD"), "utf8")).resolves.toBe(
        "ref: refs/heads/main",
      );
      expect(existsSync(join(target, "package.json"))).toBe(true);
    });
  });

  test('existingFiles="keep" 保留无关文件，只覆盖同名文件', async () => {
    await withTemporaryDirectory(async (root) => {
      const target = join(root, "occupied");
      await mkdir(target);
      await writeFile(join(target, "notes.md"), "mine", "utf8");

      await scaffoldProject(target, specOf(), "keep");

      await expect(readFile(join(target, "notes.md"), "utf8")).resolves.toBe("mine");
      expect(existsSync(join(target, "package.json"))).toBe(true);
    });
  });

  // 编译器按「模块 + 导出名」把路由 schema 重新 import 进生成的路由表，所以装饰器里引用的
  // 每个 schema 都必须是具名导出，否则生成的项目 build 报 INVALID_ROUTE_SCHEMA。这条约束
  // tsc 看不见——模板不导出照样类型正确——只能在这里钉住。
  test("装饰器引用的每个 schema 都是模板里的具名导出", async () => {
    await withTemporaryDirectory(async (root) => {
      const target = join(root, "my-api");

      const result = await scaffoldProject(target, specOf());

      const dtoFiles = result.files.filter((file) => file.endsWith(".dto.ts"));
      expect(dtoFiles.length).toBeGreaterThan(0);
      let slots = 0;
      for (const file of dtoFiles) {
        const dto = await readGenerated(target, file);
        for (const [, body] of dto.matchAll(SCHEMA_GROUP_BODY)) {
          for (const [, name] of (body ?? "").matchAll(SCHEMA_SLOT_REFERENCE)) {
            slots += 1;
            expect(dto).toContain(`export const ${name} =`);
          }
        }
      }
      expect(slots).toBeGreaterThan(0);
    });
  });

  test("生成的 .env.example 与 web-config 的前缀对得上", async () => {
    await withTemporaryDirectory(async (root) => {
      const target = join(root, "my-api");

      await scaffoldProject(target, specOf());

      const example = await readGenerated(target, ".env.example");
      const config = await readGenerated(target, "src/config/web-server.config.ts");
      expect(example).toContain("WEB_SERVER_PORT");
      expect(config).toContain('ConfigProperties("webServer"');
    });
  });

  test("不写出 node_modules 或 lockfile——装依赖不归脚手架管", async () => {
    await withTemporaryDirectory(async (root) => {
      const target = join(root, "my-api");
      await writeFile(join(root, "sentinel"), "");

      const result = await scaffoldProject(target, specOf());

      expect(result.files.some((file) => file.startsWith("node_modules"))).toBe(false);
      expect(result.files.some((file) => file.endsWith("lock.yaml"))).toBe(false);
    });
  });
});
