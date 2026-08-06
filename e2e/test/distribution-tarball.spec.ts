import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNodeExecutable, runCommand } from "@reforce/tooling-testing";
import { describe, expect, test } from "vitest";

// 发布产物边界（Issue #252）。这一层是 workspace 符号链接与真实 tarball 的分界：
// e2e 其余用例经 `workspace:*` 消费各包，pnpm 建的是指向包目录的链接，解析时整棵目录树可见，
// 因此 `files` 白名单错没错对它们完全不可见。这里改用 `pnpm pack --dry-run` 取真实打包清单，
// 断言的是「用户 npm install 之后拿到的东西」，不是「仓库里有什么」。
//
// 被这道边界挡住的具体事故：`dist/` 在 .gitignore 里，包一旦没有 `files` 字段，pack 就按
// .gitignore 把构建产物整个排除、同时把 src/ 与 test/ 打进去——发出去的包 exports 全部指空。

const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));
const packagesRoot = join(workspaceRoot, "packages");
const packTimeout = 120_000;

// 用 node 直跑 pnpm 的 JS 入口，而不是 spawn "pnpm"：runCommand 固定 shell: false，
// Windows 上 PATH 里的 pnpm 是 .cmd shim，直接 spawn 解析不到。e2e 的唯一入口是
// `pnpm run test:e2e`（经 turbo 仍是 pnpm run 起的脚本），npm_execpath 必然已被 pnpm 设置。
function resolvePnpmEntry(): string {
  const entry = process.env.npm_execpath;
  if (entry === undefined) {
    throw new Error(
      "npm_execpath is unset — run the distribution tarball suite through `pnpm run test:e2e`.",
    );
  }
  return entry;
}

interface PackedFile {
  readonly path: string;
}

interface PackReport {
  readonly files: readonly PackedFile[];
}

function isPackReport(value: unknown): value is PackReport {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const files = Reflect.get(value, "files");
  return (
    Array.isArray(files) && files.every((file) => typeof Reflect.get(file, "path") === "string")
  );
}

function readField(manifest: unknown, key: string): unknown {
  if (typeof manifest !== "object" || manifest === null) {
    return undefined;
  }
  return Reflect.get(manifest, key);
}

// exports 的值可以是字符串、条件对象或 null（屏蔽子路径）；bin 可以是字符串或映射。
// 只收字符串叶子，其余结构原样递归。
function collectDeclaredPaths(value: unknown): readonly string[] {
  if (typeof value === "string") {
    return [value.replace(/^\.\//, "")];
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap((nested) => collectDeclaredPaths(nested));
  }
  return [];
}

interface PackagedDistribution {
  readonly name: string;
  readonly declaredPaths: readonly string[];
  readonly packedPaths: readonly string[];
}

async function packPackage(
  nodeExecutable: string,
  pnpmEntry: string,
  directory: string,
): Promise<PackagedDistribution> {
  const packageRoot = join(packagesRoot, directory);
  const manifest: unknown = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const result = await runCommand(nodeExecutable, [pnpmEntry, "pack", "--dry-run", "--json"], {
    cwd: packageRoot,
    timeout: packTimeout,
  });
  if (result.exitCode !== 0) {
    throw new Error(`pnpm pack failed in ${directory}.\n${result.stdout}\n${result.stderr}`);
  }
  const report: unknown = JSON.parse(String(result.stdout));
  if (!isPackReport(report)) {
    throw new Error(`Unexpected pnpm pack report shape in ${directory}: ${String(result.stdout)}`);
  }
  const declaredPaths = ["exports", "bin", "main", "types"].flatMap((field) =>
    collectDeclaredPaths(readField(manifest, field)),
  );
  const name = readField(manifest, "name");
  if (typeof name !== "string") {
    throw new Error(`${directory}/package.json has no name field.`);
  }
  return {
    name,
    declaredPaths: [...new Set(declaredPaths)],
    packedPaths: report.files.map((file) => file.path),
  };
}

const nodeExecutable = await resolveNodeExecutable();
const pnpmEntry = resolvePnpmEntry();
const packageDirectories = (await readdir(packagesRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const distributions = await Promise.all(
  packageDirectories.map((directory) => packPackage(nodeExecutable, pnpmEntry, directory)),
);

// 源码目录与仓库工具链配置：留在 tarball 里不会让包不可用，但会把内部实现和测试树发给用户，
// 且 tsconfig / vitest.config 被下游 TS 项目扫到会产生莫名其妙的解析错误。
const sourceDirectories = ["src", "test", "it", "bench"];
const repositoryToolingFile =
  /^(?:tsconfig(?:\..+)?\.json|turbo\.json|biome\.jsonc?|.+\.config\.ts)$/;

describe("publishable package distribution", () => {
  test("covers every package under packages/", () => {
    expect(distributions.length).toBe(packageDirectories.length);
    expect(distributions.length).toBeGreaterThan(0);
  });

  test.each(distributions)(
    "$name ships every entry point its manifest declares",
    ({ declaredPaths, packedPaths }) => {
      const packed = new Set(packedPaths);
      const missing = declaredPaths.filter((path) => !packed.has(path));

      expect(declaredPaths.length).toBeGreaterThan(0);
      expect(missing).toEqual([]);
    },
  );

  test.each(distributions)(
    "$name keeps sources and repository tooling out of the tarball",
    ({ packedPaths }) => {
      const leaked = packedPaths.filter((path) => {
        const [head, ...rest] = path.split("/");
        if (head === undefined) {
          return false;
        }
        if (rest.length > 0) {
          return sourceDirectories.includes(head);
        }
        return repositoryToolingFile.test(head);
      });

      expect(leaked).toEqual([]);
    },
  );
});
