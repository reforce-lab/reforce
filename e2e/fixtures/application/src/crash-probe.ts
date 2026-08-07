import { Injectable, type OnContextStart } from "@reforce/core";

// 崩溃接管的完整链路只能在真子进程上验（RFC 0011 C2，#250）：记录是否完整落地、退出码
// 是否仍是 1，都不是 in-process 测得出来的。
@Injectable()
export class CrashProbe implements OnContextStart {
  onContextStart(): void {
    if (process.env.REFORCE_E2E_CRASH === undefined) {
      return;
    }
    // 定时器而不是同步 throw：现场要落在「应用已经 ready、正在跑」的那一刻，而不是启动
    // 失败那一刻——后者走的是 BOOTSTRAP_FAILED，是另一条路。
    setTimeout(() => {
      throw new Error("deliberate e2e crash");
    }, 200).unref();
  }
}
