import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createTemporaryProject,
  resolveNodeExecutable,
  runCommand,
  type TemporaryProject,
} from "@reforce/tooling-testing";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { installApplicationPackages } from "../support/application-packages";

// create-reforce 模板的安全网（#275）：scaffold 出来的项目此前没有任何编译级 CI 覆盖，
// 模板改坏只有用户会发现（S2 切槽位写法后旧模板就是这样静默烂掉的）。这里走真实链路：
// 真 bin scaffold → 装配 workspace 包 → 真 reforce build，tsc 可见的坏（类型不对）和
// compiler-only 的坏（schema 追溯不到、槽位不合法）都拦得住。模板 dto 用的是真 zod，
// 顺带冒烟「z.infer 别名 → typeof → schema 值」的编译期追溯。

const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));
const createReforceEntry = join(workspaceRoot, "packages", "create-reforce", "dist", "index.js");
const cliEntry = join(workspaceRoot, "packages", "cli", "dist", "reforce.js");
const zodRoot = fileURLToPath(new URL(".", import.meta.resolve("zod/package.json")));
const nodeExecutable = await resolveNodeExecutable();
const commandTimeout = 120_000;

describe("create-reforce 模板", () => {
  let project: TemporaryProject;

  beforeAll(async () => {
    project = await createTemporaryProject();
  });

  afterAll(async () => {
    await project.cleanup();
  });

  test(
    "scaffold 出来的项目通过真实 reforce build",
    async () => {
      const scaffold = await runCommand(
        nodeExecutable,
        [createReforceEntry, "my-api", "--engine", "hono", "--yes"],
        { cwd: project.projectRoot, timeout: commandTimeout },
      );
      expect(scaffold.exitCode, `${scaffold.stdout}\n${scaffold.stderr}`).toBe(0);

      const applicationRoot = join(project.projectRoot, "my-api");
      await installApplicationPackages(applicationRoot, "workspace", ["web-hono"]);
      // zod 是模板声明的运行时依赖（dto 与 app.config 都 import 它），装配层只管
      // @reforce 包；zod 没有传递依赖，符号链接真实包即可。
      await symlink(
        zodRoot,
        join(applicationRoot, "node_modules", "zod"),
        process.platform === "win32" ? "junction" : "dir",
      );

      const build = await runCommand(
        nodeExecutable,
        [cliEntry, "build", "--project", applicationRoot],
        { timeout: commandTimeout },
      );
      expect(build.exitCode, `${build.stdout}\n${build.stderr}`).toBe(0);
    },
    commandTimeout * 2,
  );
});
