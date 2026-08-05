import { join } from "node:path";
import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// 全仓 vitest 配置的唯一出处（#207）：TC39 标准装饰器必须经 SWC 降级——esbuild 0.28
// 实测原样保留装饰器语法（只支持 legacy experimentalDecorators），而 Node 26 没有原生
// 装饰器，vitest 默认转换链会在装饰器类上炸 SyntaxError。SWC decoratorVersion 2023-11
// 与 rslib 构建链同源，spike 已验证 class/method 装饰器按提案语义执行。
// fileParallelism: false 贴齐 bun test 的单进程串行语义：IT 大量 spawn 子进程、起真实
// 服务器，先保确定性，提速另案评估。
// "@" 别名复刻各包 tsconfig 的 "@/*" → "./src/*"：turbo 永远在包目录跑 test，cwd 即包根。
export function defineReforceVitestConfig(options?: {
  readonly testTimeout?: number;
}): ReturnType<typeof defineConfig> {
  return defineConfig({
    plugins: [
      swc.vite({
        jsc: {
          parser: { syntax: "typescript", decorators: true, tsx: false },
          transform: { decoratorVersion: "2023-11" },
          target: "esnext",
        },
        module: { type: "es6" },
      }),
    ],
    resolve: {
      alias: { "@": join(process.cwd(), "src") },
    },
    test: {
      fileParallelism: false,
      // bun test 的 --timeout 同时管测试与钩子；重活的 beforeAll（构建临时工程）按同值放宽
      ...(options?.testTimeout === undefined
        ? {}
        : { testTimeout: options.testTimeout, hookTimeout: options.testTimeout }),
    },
  });
}
