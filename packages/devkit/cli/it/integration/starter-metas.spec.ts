import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { createTemporaryProject, type TemporaryProject } from "@reforce/tooling-testing";
import { afterEach, expect, test } from "vitest";
import { discoverInstalledStarters, multipleCopyGroups } from "@/explain/starter-metas";

// explain 的静态 meta 发现（#148）：从 manifest 出现过的包出发、沿 starterDeps 递归；嵌套安装的
// 拷贝从引入者的包根解析（node_modules 布局即引入链的载体）；符号链接按物理路径去重。

const projects: TemporaryProject[] = [];

afterEach(async () => {
  await Promise.all(projects.splice(0).map((project) => project.cleanup()));
});

function starterTree(options: {
  readonly name: string;
  readonly version: string;
  readonly starterDeps?: readonly string[];
  readonly beans?: readonly Record<string, unknown>[];
}) {
  return {
    "package.json": `${JSON.stringify({
      name: options.name,
      version: options.version,
      type: "module",
      exports: { "./reforce-meta": "./reforce-meta.json" },
    })}\n`,
    "reforce-meta.json": `${JSON.stringify({
      schemaVersion: 1,
      starterDeps: options.starterDeps ?? [],
      symbols: [],
      beans: options.beans ?? [],
    })}\n`,
  };
}

test("discovers a starter and follows its starterDeps from the dependent package root", async () => {
  const project = await createTemporaryProject({
    node_modules: {
      "@acme": {
        "starter-a": {
          ...starterTree({
            name: "@acme/starter-a",
            version: "1.0.0",
            starterDeps: ["@acme/starter-b"],
          }),
          node_modules: {
            "@acme": {
              "starter-b": starterTree({ name: "@acme/starter-b", version: "2.0.0" }),
            },
          },
        },
        "starter-b": starterTree({ name: "@acme/starter-b", version: "1.0.0" }),
      },
    },
  });
  projects.push(project);

  const starters = await discoverInstalledStarters(project.projectRoot, ["@acme/starter-a"]);

  expect(starters.map((starter) => `${starter.packageName}@${starter.version}`)).toEqual([
    "@acme/starter-a@1.0.0",
    "@acme/starter-b@2.0.0",
  ]);
  expect(starters[1]?.introducedBy).toBe("@acme/starter-a@1.0.0");
  expect(starters[1]?.location).toBe("node_modules/@acme/starter-a/node_modules/@acme/starter-b");
});

test("reports two physical copies of one package as a multiple-copy group", async () => {
  const project = await createTemporaryProject({
    node_modules: {
      "@acme": {
        "starter-a": {
          ...starterTree({
            name: "@acme/starter-a",
            version: "1.0.0",
            starterDeps: ["@acme/starter-b"],
          }),
          node_modules: {
            "@acme": {
              "starter-b": starterTree({ name: "@acme/starter-b", version: "2.0.0" }),
            },
          },
        },
        "starter-b": starterTree({ name: "@acme/starter-b", version: "1.0.0" }),
      },
    },
  });
  projects.push(project);

  const starters = await discoverInstalledStarters(project.projectRoot, [
    "@acme/starter-a",
    "@acme/starter-b",
  ]);

  const groups = multipleCopyGroups(starters);
  expect([...groups.keys()]).toEqual(["@acme/starter-b"]);
  const copies = groups.get("@acme/starter-b") ?? [];
  expect(copies.map((copy) => copy.version).sort()).toEqual(["1.0.0", "2.0.0"]);
});

test("deduplicates a hoisted and a linked location resolving to one physical copy", async () => {
  const project = await createTemporaryProject({
    "linked-starter": starterTree({ name: "@acme/starter-a", version: "1.0.0" }),
    node_modules: {
      "@acme": {
        "starter-b": starterTree({
          name: "@acme/starter-b",
          version: "1.0.0",
          starterDeps: ["@acme/starter-a"],
        }),
      },
    },
  });
  projects.push(project);
  await mkdir(join(project.projectRoot, "node_modules", "@acme"), { recursive: true });
  await symlink(
    join(project.projectRoot, "linked-starter"),
    join(project.projectRoot, "node_modules", "@acme", "starter-a"),
    "junction",
  );

  const starters = await discoverInstalledStarters(project.projectRoot, [
    "@acme/starter-a",
    "@acme/starter-b",
  ]);

  expect(starters.filter((starter) => starter.packageName === "@acme/starter-a")).toHaveLength(1);
  expect(multipleCopyGroups(starters).size).toBe(0);
});

test("skips a registered package that is not installed", async () => {
  const project = await createTemporaryProject({});
  projects.push(project);

  const starters = await discoverInstalledStarters(project.projectRoot, ["@acme/starter-a"]);

  expect(starters).toEqual([]);
});
