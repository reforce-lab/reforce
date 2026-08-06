import type { LogRecord } from "@/contracts";

// JSON 形态的记录渲染。住在自己的文件里而不是跟着默认绑定，是因为引导缓冲的 drainToStderr
// 也要用它：缓冲 → 默认绑定 → 级别绑定 → 引导注册表 → 缓冲 会绕回一个 import 环，而环里
// 只要有一个模块在顶层求值就会拿到未初始化的绑定。

// err 是保留字段名：Error 不是 JSON 可序列化的（message/stack 都是不可枚举的），不特判就
// 会被 stringify 成 {}。
export function renderRecord(record: LogRecord): Readonly<Record<string, unknown>> {
  const { err, ...rest } = record.fields;
  return {
    level: record.level,
    time: record.time,
    name: record.name,
    message: record.message,
    ...rest,
    ...(err instanceof Error
      ? { err: { name: err.name, message: err.message, stack: err.stack } }
      : err === undefined
        ? {}
        : { err }),
  };
}
