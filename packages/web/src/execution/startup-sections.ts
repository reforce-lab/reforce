import type { WebStartupFacts } from "@/execution/connect";

// 启动摘要的段落（RFC 0011 D2，#242 / #250）。生成的 bootstrap 调它，把结果交给
// @reforce/logging 的 emitStartupSummary。
//
// 段落形状写成结构性字面量而不是 `import type { StartupSummarySection }`：type-only import
// 会留在生成的 d.ts 里，等于把 @reforce/logging 变成 @reforce/web 的硬依赖（同 RequestLogger
// 那段的理由）。两边形状一致由 emitStartupSummary 的形参在 bootstrap 那一处对上。
export interface StartupSection {
  readonly label: string;
  readonly facts: readonly string[];
  readonly expandWith?: string;
}

export interface RuntimeStartupFacts {
  /** 生成物已知的 bean 条数。 */
  readonly beanCount: number;
  /** 容器 start 的耗时，毫秒。 */
  readonly contextMs: number;
}

// 折叠必带计数与展开命令（不变量 4）：`4 controllers · 37 routes` 后面明写
// `reforce explain routes`。只折叠不给出口，读者只能去翻源码——那等于把信息藏起来还假装
// 简洁了。
export function webStartupSections(
  web: WebStartupFacts,
  runtime: RuntimeStartupFacts,
): readonly StartupSection[] {
  return [
    {
      label: "context",
      facts: [`${runtime.beanCount} beans`, `${runtime.contextMs}ms`],
      expandWith: "reforce explain beans",
    },
    {
      label: "routes",
      facts: [
        `${web.controllerCount} ${plural(web.controllerCount, "controller")}`,
        `${web.routeCount} ${plural(web.routeCount, "route")}`,
      ],
      expandWith: "reforce explain routes",
    },
    ...web.engines.map((engine) => ({
      label: engine.name,
      // 端口 0（临时端口）时这一行是唯一的实际端口出口，所以地址缺席要明说，不能静默省略。
      facts: [engine.address === undefined ? "started" : `listening on ${engine.address.url}`],
    })),
  ];
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}
