import { join } from "node:path";
import { createTemporaryProject, type TemporaryProject } from "@reforce/tooling-testing";
import { afterEach, expect, test } from "vitest";
import { findIncompleteDistTransaction } from "@/project/directory-transaction";

const projects: TemporaryProject[] = [];

afterEach(async () => {
  await Promise.all(projects.splice(0).map((project) => project.cleanup()));
});

test("the start gate reports every staging and backup leftover in sorted order", async () => {
  // staging 与 backup 并存正是这个闸门要抓的典型状态（崩在 commit 中途）。readdir 顺序因文件系统
  // 而异（ext4 哈希序 / APFS / NTFS 各不同），报告内容不得取决于平台（Issue #314）。
  const project = await createTemporaryProject({
    "dist.backup-aaa": {},
    "dist.staging-bbb": {},
    dist: { "main.mjs": "export {};\n" },
  });
  projects.push(project);

  const incomplete = await findIncompleteDistTransaction(project.projectRoot);

  expect(incomplete).toEqual({
    reason: "artifact",
    entryNames: ["dist.backup-aaa", "dist.staging-bbb"],
  });
});

test("the start gate reports journal leftovers by entry name in sorted order", async () => {
  const project = await createTemporaryProject({
    ".reforce": {
      transactions: {
        dist: {
          "token-b": { "journal.json": "{}\n" },
          "token-a": { "journal.json": "{}\n" },
        },
      },
    },
    dist: { "main.mjs": "export {};\n" },
  });
  projects.push(project);

  const incomplete = await findIncompleteDistTransaction(project.projectRoot);

  expect(incomplete).toEqual({ reason: "journal", entryNames: ["token-a", "token-b"] });
});

test("a missing project root counts as no incomplete transaction instead of a raw ENOENT", async () => {
  // 闸门跑在 resolveProductionEntry 的错误归类之前：裸 ENOENT 会绕过 ARTIFACT_INVALID，
  // 「项目根不存在」应交给后续 dist 检查去归类（Issue #314）。
  const project = await createTemporaryProject({});
  projects.push(project);
  const missingRoot = join(project.projectRoot, "does-not-exist");

  await expect(findIncompleteDistTransaction(missingRoot)).resolves.toBeUndefined();
});

test("a project without transaction leftovers has no incomplete transaction", async () => {
  const project = await createTemporaryProject({ dist: { "main.mjs": "export {};\n" } });
  projects.push(project);

  await expect(findIncompleteDistTransaction(project.projectRoot)).resolves.toBeUndefined();
});
