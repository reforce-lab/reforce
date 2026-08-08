import {
  isLevelEnabled,
  type LogFields,
  type Logger,
  type LogLevel,
  type LogRecord,
} from "@/contracts";
import { renderShortRecord } from "@/render-record";

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
      // 退场后转发给真 logger：句柄可以被长期持有（模块作用域取一次、一直用），退场前它
      // 回答「这条会不会被留给真 logger」，退场后必须回答真 logger 的判定——继续按缓冲
      // 阈值答，调用方会在真 logger 已关掉的级别上白构造字段（不变量 8 的另一半）。
      isEnabled: (level) =>
        retired && live !== undefined
          ? live(name).isEnabled(level)
          : isLevelEnabled(level, threshold),
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
        // 字段名不是 `time`：重放走的是普通 Logger 调用，字段被绑定平铺进记录顶层，而 `time`
        // 正是 pino 自己写的顶层键——实测同一行 JSON 里出现两个 time，取前者的解析器拿到的是
        // 重放时刻，恰好把「保留原始时间戳」这个目的破掉。叫 bootstrapTime 也更准确：它与这
        // 条记录的 time 是两个不同的时刻，重放时刻并不因此消失。
        resolve(record.loggerName)[record.level](
          { ...record.fields, bootstrapTime: record.time },
          record.message,
        );
      }
    },
    drainToStderr(write = (line) => void process.stderr.write(`${line}\n`)) {
      // short 单行文本而不是 JSON：这条路只在绑定构造失败/退出兜底时走，读者是正在看启动
      // 失败输出的人，用户配置的格式与目标此刻都不存在（不变量 9：现场必须先出来）。
      for (const record of records.splice(0)) {
        write(renderShortRecord(record));
      }
      if (dropped > 0) {
        write(`[reforce.bootstrap] ${dropped} buffered record(s) were dropped before this drain.`);
      }
    },
  };
}
