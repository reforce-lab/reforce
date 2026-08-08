import type { WebStartupFacts } from "@/execution/connect";

// 启动摘要的段落（RFC 0011 D2，#242 / #250）。生成的 bootstrap 调它，把结果交给
// @reforce/logging 的 emitStartupSummary。
//
// 段落形状写成结构性字面量而不是 `import type { StartupSummarySection }`：type-only import
// 会留在生成的 d.ts 里，等于把 @reforce/logging 变成 @reforce/web-core 的硬依赖（同 RequestLogger
// 那段的理由）。两边形状一致由 emitStartupSummary 的形参在 bootstrap 那一处对上。
export interface StartupSection {
  readonly label: string;
  readonly facts: readonly string[];
  readonly expandWith?: string;
}

// 折叠必带计数与展开命令（不变量 4）：`4 controllers · 37 routes` 后面明写
// `reforce explain routes`。只折叠不给出口，读者只能去翻源码——那等于把信息藏起来还假装
// 简洁了。
//
// context 段不在这里：bean 数与容器耗时是容器的事实不是 web 的，它归 @reforce/logging 的
// contextStartupSections（RFC 0011 L6【已定】的两命名空间划分）。放在这边的后果是没有引擎的
// 应用连这一节都看不到。
export function webStartupSections(web: WebStartupFacts): readonly StartupSection[] {
  return [
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
