import {
  isLevelEnabled,
  type LogFields,
  type Logger,
  type LogLevel,
  type LogRecord,
} from "@/contracts";
import { renderRecord } from "@/default-logger";

// 引导期缓冲（RFC 0011 L7，#242）。
//
// 绑定 bean 存在之前就有话要说——容器还没构造完，LoggerFactory 也就还不存在。这段时间的记录
// 攒进有界环形缓冲，绑定就位后按原始时间戳重放，然后引导 logger 退场。
//
// 三条硬约束：
//   1. 缓冲有界，溢出丢**最旧**的并计数。丢新的会让「刚刚发生什么」消失，而引导期最后几条
//      恰恰是失败现场。
//   2. 绑定构造失败时缓冲按 short 模式吐 stderr，绝不静默丢弃——那时它是唯一的现场。
//   3. 重放用记录里的原始时间戳，不是重放时刻，否则引导期的时序全被压平成同一瞬间。

export interface BootstrapLogBuffer {
  readonly logger: (name: string) => Logger;
  /** 绑定就位后按原始时间戳重放，并让引导 logger 退场。 */
  replayInto(resolve: (name: string) => Logger): void;
  /** 绑定构造失败时的最后手段：把攒下的记录吐到 stderr。 */
  drainToStderr(write?: (line: string) => void): void;
  readonly droppedCount: () => number;
}

interface BufferedRecord extends LogRecord {
  readonly loggerName: string;
}

export function createBootstrapLogBuffer(
  options: {
    readonly capacity?: number;
    readonly threshold?: LogLevel;
    readonly now?: () => number;
  } = {},
): BootstrapLogBuffer {
  const capacity = options.capacity ?? 256;
  const threshold = options.threshold ?? "info";
  const now = options.now ?? (() => Date.now());
  const records: BufferedRecord[] = [];
  let dropped = 0;
  let retired = false;
  let live: ((name: string) => Logger) | undefined;

  const push = (
    loggerName: string,
    level: LogLevel,
    fields: LogFields | undefined,
    message: string,
  ) => {
    if (records.length >= capacity) {
      records.shift();
      dropped += 1;
    }
    records.push({
      loggerName,
      level,
      name: loggerName,
      time: now(),
      message,
      fields: fields ?? {},
    });
  };

  const bootstrapLogger = (name: string): Logger => {
    const emit = (level: LogLevel) => (fields: LogFields | undefined, message: string) => {
      // 退场之后仍持有旧句柄的调用方直接转发给真 logger，而不是继续攒——否则那些记录
      // 再也不会被重放。
      if (retired && live !== undefined) {
        live(name)[level](fields, message);
        return;
      }
      if (!isLevelEnabled(level, threshold)) {
        return;
      }
      push(name, level, fields, message);
    };
    return {
      isEnabled: (level) => isLevelEnabled(level, threshold),
      trace: emit("trace"),
      debug: emit("debug"),
      info: emit("info"),
      warn: emit("warn"),
      error: emit("error"),
      fatal: emit("fatal"),
    };
  };

  return {
    logger: bootstrapLogger,
    droppedCount: () => dropped,
    replayInto(resolve) {
      live = resolve;
      retired = true;
      const pending = records.splice(0);
      if (dropped > 0) {
        resolve("reforce.bootstrap").warn(
          { droppedRecords: dropped },
          "Bootstrap log buffer overflowed; the oldest records were dropped.",
        );
      }
      for (const record of pending) {
        // 原始时间戳：重放时刻会把引导期的时序压平。
        resolve(record.loggerName)[record.level](
          { ...record.fields, time: record.time },
          record.message,
        );
      }
    },
    drainToStderr(write = (line) => void process.stderr.write(`${line}\n`)) {
      for (const record of records.splice(0)) {
        write(JSON.stringify(renderRecord(record)));
      }
      if (dropped > 0) {
        write(`[reforce.bootstrap] ${dropped} buffered record(s) were dropped before this drain.`);
      }
    },
  };
}
