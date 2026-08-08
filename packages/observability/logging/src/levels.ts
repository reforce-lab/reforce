// 级别快照（RFC 0011 L5 勘误，#242）。这个 bean 由编译器合成，构造实参是编译期算好的字面量——
// 它是「编译期看见了哪些 logger 名」的封闭名单，不是级别的真相：级别的真相在应用的
// LoggingSettings bean 里（settings.ts）。名单的唯一职责是让启动期能对 settings.levels 的键
// 做确定性 did-you-mean——每次启动必报，而不是等那条 logger 恰好打日志时才发现没生效。
export interface LoggerLevelsSnapshot {
  /** 编译期见到的全部 logger 名，封闭名单。 */
  readonly names: readonly string[];
}

export class LoggerLevels {
  private readonly snapshot: LoggerLevelsSnapshot;

  constructor(snapshot: LoggerLevelsSnapshot) {
    this.snapshot = snapshot;
  }

  get names(): readonly string[] {
    return this.snapshot.names;
  }
}
