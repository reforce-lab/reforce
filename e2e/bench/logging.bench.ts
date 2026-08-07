// 基准 ③（RFC 0011，#250）：日志门面的开销。
//
// **参照系必须三档**，缺任何一档就是自我感觉良好：
//   ① 裸 pino 直调——不经门面，这是「不用 reforce 能跑多快」的天花板
//   ② 门面 → pino 绑定——门面这一层到底吃掉多少
//   ③ 门面 → 默认零依赖 writer——不装 pino 时的实际体验
// 只报 ②vs③ 正是 #242 风险 2 点名的「只对比我们自己的两个版本」：那样无论多慢都能得出
// 「我们的两个版本差不多」这种毫无信息量的结论。
//
// 另跑一档 **sonic-boom 真文件写**：只测内存 sink 会系统性低估 pino 的优势（它的价值恰恰在
// 异步写），从而抬高门面的相对分数。
//
// 不进 CI、不设阈值断言——仓库里没有框架税门禁（#242 勘误第 11 条：#201 的 17% 只是一句注释，
// 无数字、无基线文件、无 CI 检查），能对位的只有方法学。数字写进 PR 描述。
//
// 复跑：`pnpm --dir e2e run bench:logging`。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import {
  DefaultLoggerFactory,
  type LogFieldSource,
  type Logger,
  LoggerLevels,
} from "@reforce/logging";
import { PinoLoggerFactory } from "@reforce/logging-pino";
// destination 挂在默认导出上，不在具名 pino 上（pino 10 的类型如此）。
import pinoDefault, { pino } from "pino";

const iterations = 200_000;
const rounds = 5;

// 防 DCE 的 sink：写出的字节数累加进一个必须被读的变量，否则整个循环可能被优化掉。
let sink = 0;

function countingStream(): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      sink += chunk.length;
      callback();
    },
  });
}

// 三档必须用**等价的 sink**，否则比的是 sink 不是日志库。第一版这里给默认 writer 的是
// 「直接累加字符串长度」，而 pino 两档走真 Writable——测出来默认绑定快 3 倍，那是 sink 的
// 差异，不是它的优势。所有档位一律写进同一种 Writable。
function streamWriter(stream: Writable): (line: string) => void {
  return (line) => {
    stream.write(`${line}\n`);
  };
}

function fieldSources(count: number): readonly LogFieldSource[] {
  return Array.from({ length: count }, (_value, index) => ({
    fields: () => ({ [`ambient${index}`]: index }),
  }));
}

function payloadOf(size: number): Record<string, unknown> {
  return Object.fromEntries(Array.from({ length: size }, (_v, i) => [`field${i}`, i]));
}

function measure(run: () => void): number {
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    run();
  }
  return iterations / ((performance.now() - started) / 1000);
}

function best(run: () => void): number {
  let top = 0;
  for (let round = 0; round < rounds; round += 1) {
    top = Math.max(top, measure(run));
  }
  return top;
}

// —— 三档参照系 ——

// 空名单的级别快照：基准比的是每条记录的写出开销，逐 logger 调级不在被测面内，名单为空
// 意味着每条 logger 都落回 defaultLevel，三档的门槛因此一致。
const benchLevels = new LoggerLevels({ names: [], levels: {}, defaultLevel: "info", layers: [] });

const barePino = pino({ level: "info" }, countingStream()).child({ name: "bench" });
const facadeOverPino = new PinoLoggerFactory(
  {},
  [],
  [],
  [{ destination: () => countingStream() }],
  benchLevels,
  { defaultLevel: "info" },
).create("bench");
const facadeOverDefault = new DefaultLoggerFactory({
  defaultLevel: "info",
  write: streamWriter(countingStream()),
}).create("bench");

const twoFields = payloadOf(2);

const results = new Map<string, number>([
  ["① 裸 pino 直调", best(() => barePino.info(twoFields, "request"))],
  ["② 门面 → pino", best(() => facadeOverPino.info(twoFields, "request"))],
  ["③ 门面 → 默认 writer", best(() => facadeOverDefault.info(twoFields, "request"))],
]);

// —— sonic-boom 真文件写：内存 sink 会系统性低估 pino ——

const fileRoot = mkdtempSync(join(tmpdir(), "reforce-logging-bench-"));
const filePino = pino({ level: "info" }, pinoDefault.destination(join(fileRoot, "bare.log"))).child(
  { name: "bench" },
);
const fileFacade = new PinoLoggerFactory(
  {},
  [],
  [],
  [{ destination: () => pinoDefault.destination(join(fileRoot, "facade.log")) }],
  benchLevels,
  { defaultLevel: "info" },
).create("bench");
results.set(
  "① 裸 pino → sonic-boom 文件",
  best(() => filePino.info(twoFields, "request")),
);
results.set(
  "② 门面 → pino → sonic-boom 文件",
  best(() => fileFacade.info(twoFields, "request")),
);

// —— 必测的四个变量 ——

// 1. 级别关闭路径。硬断言 LogFieldSource 零调用：不变量 8 是实现约束，基准里跑一遍能确保
//    它不是「测的时候成立、真跑时被优化掉」。
let disabledSourceCalls = 0;
const disabled = new DefaultLoggerFactory({
  defaultLevel: "error",
  fieldSources: [
    {
      fields: () => {
        disabledSourceCalls += 1;
        return { traceId: "x" };
      },
    },
  ],
  write: () => {},
}).create("bench");
results.set(
  "级别关闭（应接近零成本）",
  best(() => disabled.debug(twoFields, "dropped")),
);
if (disabledSourceCalls !== 0) {
  throw new Error(`不变量 8 被破坏：级别关闭时 LogFieldSource 被调用了 ${disabledSourceCalls} 次`);
}

// 2. LogFieldSource 集合规模 N=0/1/3
for (const count of [0, 1, 3]) {
  const logger: Logger = new DefaultLoggerFactory({
    defaultLevel: "info",
    fieldSources: fieldSources(count),
    write: streamWriter(countingStream()),
  }).create("bench");
  results.set(
    `集合注入 N=${count}`,
    best(() => logger.info(twoFields, "request")),
  );
}

// 3. 字段数量梯度
for (const size of [0, 2, 8]) {
  const fields = payloadOf(size);
  results.set(
    `字段数=${size}`,
    best(() => facadeOverDefault.info(fields, "request")),
  );
}

if (sink === 0) {
  throw new Error("unreachable: 写出的字节数为零说明循环被优化掉了");
}
rmSync(fileRoot, { recursive: true, force: true });

const rows = [...results].map(([label, opsPerSecond]) => ({
  label,
  opsPerSecond,
}));
const baseline = results.get("① 裸 pino 直调") ?? 1;

console.log(
  `Node.js ${process.version} · ${process.platform}-${process.arch} · iterations=${iterations} × rounds=${rounds}（取每轮最好值）`,
);
console.log("");
console.log("| 档位 | ops/s | 相对①裸 pino |");
console.log("| --- | ---: | ---: |");
for (const row of rows) {
  const relative = `${((row.opsPerSecond / baseline) * 100).toFixed(1)}%`;
  console.log(
    `| ${row.label} | ${Math.round(row.opsPerSecond).toLocaleString("en-US")} | ${relative} |`,
  );
}
console.log("");
console.log(
  "注：单进程同机测量，未拆分「序列化 / 写出 / 门面自身」三段——相对百分比可比，绝对值不可跨机比较。",
);
