import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { createTemporaryProject, type TemporaryProject } from "@reforce/tooling-testing";
import { collectInstallSignalInputs } from "@/dev/install-signals";

// dev loop install 信号面的分类规则（Issue #148）：存在的路径进 fileDependencies、缺失的进
// missingDependencies；bun.lock 的候选位置是应用目录加每个带 package.json 的祖先目录
// （workspace 成员的锁文件在 workspace 根）。

const projects: TemporaryProject[] = [];

afterEach(async () => {
  await Promise.all(projects.splice(0).map((project) => project.cleanup()));
});

async function temporaryTree(tree: Parameters<typeof createTemporaryProject>[0]) {
  const project = await createTemporaryProject(tree);
  projects.push(project);
  return project;
}

test("registers an existing application package.json and bun.lock as file dependencies", async () => {
  const project = await temporaryTree({
    "package.json": "{}\n",
    "bun.lock": "{}\n",
  });

  const inputs = await collectInstallSignalInputs(project.projectRoot);

  expect(inputs.fileDependencies).toContain(join(project.projectRoot, "package.json"));
  expect(inputs.fileDependencies).toContain(join(project.projectRoot, "bun.lock"));
  expect(inputs.contextDependencies).toEqual([]);
});

test("registers missing package.json and bun.lock as missing dependencies", async () => {
  const project = await temporaryTree({});

  const inputs = await collectInstallSignalInputs(project.projectRoot);

  expect(inputs.missingDependencies).toContain(join(project.projectRoot, "package.json"));
  expect(inputs.missingDependencies).toContain(join(project.projectRoot, "bun.lock"));
});

test("registers the workspace root bun.lock for a nested workspace member", async () => {
  const project = await temporaryTree({
    "package.json": "{}\n",
    "bun.lock": "{}\n",
    apps: {
      api: {
        "package.json": "{}\n",
      },
    },
  });
  const memberRoot = join(project.projectRoot, "apps", "api");

  const inputs = await collectInstallSignalInputs(memberRoot);

  expect(inputs.fileDependencies).toContain(join(project.projectRoot, "bun.lock"));
  // 成员目录自身的锁文件不存在，但仍要按缺失登记：本地 install 落锁时必须触发重发现。
  expect(inputs.missingDependencies).toContain(join(memberRoot, "bun.lock"));
});

test("does not register lock candidates for ancestors without a package.json", async () => {
  const project = await temporaryTree({
    apps: {
      api: {
        "package.json": "{}\n",
      },
    },
  });
  const memberRoot = join(project.projectRoot, "apps", "api");

  const inputs = await collectInstallSignalInputs(memberRoot);

  const candidates = [...inputs.fileDependencies, ...inputs.missingDependencies];
  expect(candidates).not.toContain(join(project.projectRoot, "apps", "bun.lock"));
});
