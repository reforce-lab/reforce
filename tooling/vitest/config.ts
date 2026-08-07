import { join } from "node:path";
import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// 测试墙钟的外层击杀钟（Issue #92）：语义是抓「卡死」，不是管「慢」——按预期耗时标定的
// 窗口在慢平台会把「正常但偏慢」判成失败（Issue #57、#75、#81），所以这个数只许「真卡死
// 才够得着」，必须显著大于内层停滞预算（@reforce/tooling-testing 的
// testStallBudgetMilliseconds = 120s）。它是教义级常量而非每包可调参数：曾经的包级
// testTimeout 选项让带重型 IT 的包各自记得放宽、忘了的停在 vitest 默认 5s，compiler 的
// 全链路 IT 就在 Windows runner 上撞线（真 tsc + esbuild + node 三次子进程冷启动）。
const killClockMilliseconds = 300_000;

// 全仓 vitest 配置的唯一出处（#207）：TC39 标准装饰器必须经 SWC 降级——esbuild 0.28
// 实测原样保留装饰器语法（只支持 legacy experimentalDecorators），而 Node 26 没有原生
// 装饰器，vitest 默认转换链会在装饰器类上炸 SyntaxError。SWC decoratorVersion 2023-11
// 与 rslib 构建链同源，spike 已验证 class/method 装饰器按提案语义执行。
// fileParallelism: false 贴齐 bun test 的单进程串行语义：IT 大量 spawn 子进程、起真实
// 服务器，先保确定性，提速另案评估。
// "@" 别名复刻各包 tsconfig 的 "@/*" → "./src/*"：turbo 永远在包目录跑 test，cwd 即包根。
export function defineReforceVitestConfig(): ReturnType<typeof defineConfig> {
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
      testTimeout: killClockMilliseconds,
      // bun test 的 --timeout 同时管测试与钩子；重活的 beforeAll（构建临时工程）按同值放宽
      hookTimeout: killClockMilliseconds,
    },
  });
}
