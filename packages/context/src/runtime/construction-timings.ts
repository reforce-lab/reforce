import type { BeanTiming, BeanTimingPhase } from "@/public-types";

// 启动台账（RFC 0011 C6，#250）：记的是**自身耗时**而不是墙钟耗时。construct 是可重入的
// （bean-resolver.ts 的 createGeneratedResolver 会在构造函数里回调 construct），构造函数里
// 调 Lazy.get() 也会真的嵌套构造一层。不减去子耗时，各条之和就会超过启动摘要里已经印着的
// contextMs，读者会当成 bug 报回来。
//
// now 可注入沿用 bootstrap-buffer.ts 的既有约定，为的是让计时用例确定，不是给用户的旋钮。
export class ConstructionTimings {
  private readonly entries: BeanTiming[] = [];
  private readonly childMs: number[] = [];
  private readonly now: () => number;

  constructor(now: () => number = () => performance.now()) {
    this.now = now;
  }

  enter(): number {
    this.childMs.push(0);
    return this.now();
  }

  exit(id: string, phase: BeanTimingPhase, startedAt: number): void {
    const elapsed = this.now() - startedAt;
    const children = this.childMs.pop() ?? 0;
    const parentIndex = this.childMs.length - 1;
    const parentChildMs = this.childMs[parentIndex];
    if (parentChildMs !== undefined) {
      this.childMs[parentIndex] = parentChildMs + elapsed;
    }
    // 3 位小数与请求日志的 handlerMs 对齐（web-application.ts），免得两处数字精度不一样。
    this.entries.push({ id, phase, ms: Math.round((elapsed - children) * 1000) / 1000 });
  }

  snapshot(): readonly BeanTiming[] {
    return Object.freeze([...this.entries]);
  }
}
