import { join } from "node:path";
import { createTemporaryProject, type TemporaryProject } from "@reforce/tooling-testing";
import { afterEach, describe, expect, test, vi } from "vitest";
import { listPackageDirectories } from "../support/package-directories";

// distribution-tarball 套件的枚举契约（Issue #299）。那个套件在模块顶层枚举 packages/*，
// 枚举一崩就是收集期失败、0 个用例执行，报告里看不出坏的是哪条契约——所以这条回归
// 必须自己造目录树来验，不能指望跑那个套件时能看出来。

let project: TemporaryProject | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await project?.cleanup();
  project = undefined;
});

// 混合目录树：正常包、改名后遗留的孤儿目录（只剩 dist/，没有 package.json）、以及分组层与
// 包分组内各一个散落文件。包一律在第二级，所以 packages/ 的一级目录全是分组名。
async function createPackagesRoot(): Promise<string> {
  const created = await createTemporaryProject({
    packages: {
      "README.md": "not a package directory\n",
      kernel: {
        "notes.md": "not a package directory either\n",
        context: { dist: { "index.js": "export {};\n" } },
        core: { "package.json": JSON.stringify({ name: "@reforce/core" }) },
      },
    },
  });
  project = created;
  return join(created.projectRoot, "packages");
}

// 放错层的包：packages/legacy/ 自己带 package.json，却和分组目录并排站。
async function createMisplacedPackageRoot(): Promise<string> {
  const created = await createTemporaryProject({
    packages: {
      kernel: { core: { "package.json": JSON.stringify({ name: "@reforce/core" }) } },
      legacy: {
        "package.json": JSON.stringify({ name: "@reforce/legacy" }),
        src: { "index.ts": "export {};\n" },
      },
    },
  });
  project = created;
  return join(created.projectRoot, "packages");
}

describe("listPackageDirectories", () => {
  test("enumerates directories that carry a package.json", async () => {
    const packagesRoot = await createPackagesRoot();
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const directories = await listPackageDirectories(packagesRoot);

    expect(directories).toContain("kernel/core");
  });

  test("skips a directory without package.json instead of throwing", async () => {
    const packagesRoot = await createPackagesRoot();
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const directories = await listPackageDirectories(packagesRoot);

    expect(directories).not.toContain("kernel/context");
  });

  test("names the skipped directory on the console", async () => {
    const packagesRoot = await createPackagesRoot();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await listPackageDirectories(packagesRoot);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("context");
  });

  test("ignores plain files sitting next to the group directories", async () => {
    const packagesRoot = await createPackagesRoot();
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const directories = await listPackageDirectories(packagesRoot);

    expect(directories).not.toContain("README.md");
  });

  test("ignores plain files sitting inside a group directory", async () => {
    const packagesRoot = await createPackagesRoot();
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const directories = await listPackageDirectories(packagesRoot);

    expect(directories).not.toContain("kernel/notes.md");
  });

  test("does not descend into a package that sits at the group level", async () => {
    const packagesRoot = await createMisplacedPackageRoot();
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const directories = await listPackageDirectories(packagesRoot);

    expect(directories).toEqual(["kernel/core"]);
  });

  test("names a package that sits at the group level", async () => {
    const packagesRoot = await createMisplacedPackageRoot();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await listPackageDirectories(packagesRoot);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("packages/legacy");
  });

  test("stays quiet when every directory is a package", async () => {
    const created = await createTemporaryProject({
      packages: {
        kernel: { core: { "package.json": JSON.stringify({ name: "@reforce/core" }) } },
      },
    });
    project = created;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await listPackageDirectories(join(created.projectRoot, "packages"));

    expect(warn).not.toHaveBeenCalled();
  });
});
