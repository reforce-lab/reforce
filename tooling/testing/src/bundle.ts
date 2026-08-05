import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { transform } from "@swc/core";
import { build, type Plugin } from "esbuild";

// bun 时代各 IT 用 `bun build`（process.execPath 即 bun）把临时工程的集成入口打成单文件
// 可执行产物；迁到 Node 后同一职责由 esbuild 承担（#207）。esbuild 不下沉 TC39 标准装饰器
// （实测原样保留语法，Node 无原生装饰器会在运行期炸 SyntaxError），所以经 onLoad 钩子先过
// 一道 SWC——decoratorVersion 与 @reforce/tooling-vitest 同源。
const swcTypeScript: Plugin = {
  name: "reforce-swc-typescript",
  setup(buildApi) {
    buildApi.onLoad({ filter: /\.ts$/ }, async (args) => {
      const result = await transform(await readFile(args.path, "utf8"), {
        filename: args.path,
        jsc: {
          parser: { syntax: "typescript", decorators: true, tsx: false },
          transform: { decoratorVersion: "2023-11" },
          target: "esnext",
        },
        module: { type: "es6" },
      });
      return { contents: result.code, loader: "js" };
    });
  },
};

export interface BundleEntryOptions {
  readonly entry: string;
  readonly cwd: string;
  readonly outdir?: string;
  readonly outfile?: string;
}

export async function bundleEntry(options: BundleEntryOptions): Promise<void> {
  await build({
    absWorkingDir: options.cwd,
    bundle: true,
    entryPoints: [options.entry],
    format: "esm",
    ...(options.outdir === undefined ? {} : { outdir: options.outdir }),
    ...(options.outfile === undefined ? {} : { outfile: options.outfile }),
    // 只打包工程代码：npm 依赖留外部（临时工程的 node_modules 由 IT 装配齐全），
    // 避免 CJS 依赖（dotenv 等）进 ESM bundle 的 dynamic-require 兼容坑
    packages: "external",
    platform: "node",
    plugins: [swcTypeScript],
  });
}

const harnessBundles = new Map<string, Promise<string>>();

// 引用包内 @/ 源码的 harness 不能由 Node 直跑（type stripping 不认 tsconfig paths，也不
// 降级 TC39 装饰器，#207）：打成单文件 mjs 再 spawn。产物落在所属包的 node_modules/.cache
// 下——bare specifier（@reforce/* 等 external 依赖）沿目录链向上解析，放系统临时目录会
// 找不到包。按入口路径去重，同一 spec 多次 spawn 只打一次。
export function bundleHarness(harnessPath: string): Promise<string> {
  const cached = harnessBundles.get(harnessPath);
  if (cached !== undefined) {
    return cached;
  }
  const bundled = (async () => {
    const packageRoot = await findPackageRoot(harnessPath);
    const cacheDirectory = join(packageRoot, "node_modules", ".cache", "reforce-harness");
    await mkdir(cacheDirectory, { recursive: true });
    const outfile = join(
      cacheDirectory,
      `${basename(harnessPath, ".ts")}-${createHash("sha256").update(harnessPath).digest("hex").slice(0, 12)}.mjs`,
    );
    await bundleEntry({ entry: harnessPath, cwd: packageRoot, outfile });
    return outfile;
  })();
  harnessBundles.set(harnessPath, bundled);
  return bundled;
}

async function findPackageRoot(path: string): Promise<string> {
  let directory = dirname(path);
  for (;;) {
    if (await pathExists(join(directory, "package.json"))) {
      return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error(`No package.json found above ${path}.`);
    }
    directory = parent;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
