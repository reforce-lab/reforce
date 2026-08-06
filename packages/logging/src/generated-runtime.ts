import type { LogFields, Logger, LoggerFactory, LogLevel } from "@/contracts";

// 生成的 bootstrap 的消费面（RFC 0011 L7/D2，#250）：容器 start 之后重放引导期缓冲、
// 绑定构造失败时把缓冲吐到 stderr、以及发出启动摘要。
export { beanTimingSections, emitBeanTimings } from "@/bean-timings";
export { drainBootstrapLogs, replayBootstrapLogs } from "@/bootstrap-registry";
export { LoggerLevels, type LoggerLevelsSnapshot } from "@/levels";
export { emitStartupSummary } from "@/startup-summary";

// 生成物消费面（RFC 0011 L2，#242）。编译器为每个 logger 名合成一条框架 bean，运行导出恒为
// 本文件的 BoundLogger，名字作为字面量构造实参内联进 beans.ts。
//
// 生成的 beans.ts 里每条 logger bean 各自 `class BoundLogger$N extends BoundLogger {}`：运行时的
// claimClassTarget 要求每条 class registration 的 target 对象互不相同，N 个 logger 共用一个类
// 会当场 fail("class target ... is duplicated")。逐个 emit 子类换来的是运行时代码零改动、
// 生成物 schema 零加字段。子类对用户不可达，所以 `context.get(BoundLogger)` 抛
// UnregisteredBeanTargetError——语义正确，logger 本来就不该按类取。
export class BoundLogger implements Logger {
  private readonly delegate: Logger;

  constructor(factory: LoggerFactory, name: string) {
    this.delegate = factory.create(name);
  }

  isEnabled(level: LogLevel): boolean {
    return this.delegate.isEnabled(level);
  }

  trace(fields: LogFields | undefined, message: string): void {
    this.delegate.trace(fields, message);
  }

  debug(fields: LogFields | undefined, message: string): void {
    this.delegate.debug(fields, message);
  }

  info(fields: LogFields | undefined, message: string): void {
    this.delegate.info(fields, message);
  }

  warn(fields: LogFields | undefined, message: string): void {
    this.delegate.warn(fields, message);
  }

  error(fields: LogFields | undefined, message: string): void {
    this.delegate.error(fields, message);
  }

  fatal(fields: LogFields | undefined, message: string): void {
    this.delegate.fatal(fields, message);
  }
}
