// HTTP 负载发生器（#338）：autocannon 独立发压，取代此前的进程内 fetch 并发循环。
//
// 换尺子的理由是旧尺子量不出被测目标：`await fetch()` + `await arrayBuffer()` 的串行循环，
// 客户端自身开销与被测服务端同量级，天花板约 2.4 万 req/s——低于裸 node:http 的 10 万，也低于
// web-fastify 与 web-hono。工具比目标慢时，测到的是工具的极限，框架税因此被压低 3~4 倍
// （旧尺子量出约 21%，autocannon 量出 76%~78%）。
//
// autocannon 是 Fastify / Hono 官方对比表通用的独立进程发压工具：预建请求缓冲、裸 socket，
// 不走 fetch 那一层。
//
// **发压默认单线程，靠每次跑分开头的校准兜底，而不是靠多起几个线程。** 实测 1/2/4/8 workers
// 打裸 node:http 都落在 9.9~10.4 万，其中单线程最快——worker 线程自己有开销，而发压侧离
// 瓶颈还差 4 倍（最快的被测目标 10 万，Reforce 2.2 万）。多线程在这里是净负担。
//
// 真正的保险是 calibrateGenerator：它每次跑分都就地量一遍「加线程还能不能更快」。将来某个
// 目标快到发压侧撑不住，它会先吠，那时再调 defaultWorkers——判据是实测，不是默认值。
//
// **噪声有两个尺度，spread 只盖住了小的那个。**
//   - 跑内（同一次 bench 的三轮之间）：中位数之后典型 ±3%~9%，就是印在表里的 spread。
//   - 跨次（同一份代码、不同时刻各跑一次 bench）：实测 Reforce /health 连续四次拿到
//     23118 / 19996 / 22034 / 23602，**±18%**。
// 也就是说 spread **低估**真实不确定性，拿两次跑的绝对吞吐做 before/after 对比不可靠，
// 哪怕两边都取了中位数。
//
// 绕过跨次漂移的办法是用**同一次跑内对裸基线的比值**（表里 `% of baseline` 那一列）：机器
// 状态的漂移同时打在基线和被测目标上，比值把它约掉了。**判断一次优化有没有效，看比值那一列，
// 不看绝对吞吐。** 比 spread 还小的改动则两列都得不出结论，必须回到微基准。

import autocannon from "autocannon";

export interface LoadOptions {
  readonly connections: number;
  readonly warmupMilliseconds: number;
  readonly durationMilliseconds: number;
  readonly headers?: Readonly<Record<string, string>>;
  /** 发压线程数；缺省见 defaultWorkers。校准用例会显式传 1 做对照。 */
  readonly workers?: number;
  /** 重复轮数，取中位数那一轮；缺省见 defaultRepetitions。 */
  readonly repetitions?: number;
}

export interface LoadResult {
  readonly requests: number;
  readonly requestsPerSecond: number;
  /**
   * 单请求服务时间（微秒）= 1e6 / 吞吐。饱和的单线程服务端上它就是每请求的 CPU 成本，
   * 因此可以直接和微基准的 ns/op 对账——「这条改动省 3.9µs」能在这一列上验证。
   * 它不是延迟：并发 32 时延迟约等于本值乘以在途请求数。
   */
  readonly microsecondsPerRequest: number;
  /**
   * autocannon 的延迟直方图存的是**整数毫秒**（`lib/run.js:244` 把 float 毫秒喂给 hdr
   * histogram，小数被截断）。所以亚毫秒响应的 p50 恒为 0、p99 在 0/1 之间跳，没有信息量；
   * 表里只印 p99，且只在延迟真的过毫秒时才可读。要亚毫秒分位得自己挂 tracker 的 response
   * 事件逐条记，那会把发压侧的开销加回来，正是本 issue 在消除的东西。
   */
  readonly p50Milliseconds: number;
  readonly p99Milliseconds: number;
  readonly failures: number;
  /**
   * 本测量点各轮吞吐的极差占中位数的比例，即**跑内**噪声。比它小的改动连在同一次跑里都分辨
   * 不出来，必须回到微基准。
   *
   * 注意它**不是**总的不确定度：跨次漂移比它大一个量级（见文件头）。跨次的 before/after
   * 对比要看 `% of baseline` 那一列，不看绝对吞吐。
   */
  readonly spreadRatio: number;
}

const defaultWorkers = 1;
// 校准时的对照组：够多到能证明「加线程也没用」，又不至于让校准本身太慢。
const calibrationWorkers = 4;
// 中位数取自奇数轮，免得还要定义「两个中间值怎么合」。3 轮是噪声与耗时的折中：每轮
// 预热 2s + 计时 8s，4 个测量点共 2 分钟。
const defaultRepetitions = 3;

async function runOnce(
  url: string,
  options: LoadOptions,
): Promise<Omit<LoadResult, "spreadRatio">> {
  const result = await autocannon({
    url,
    connections: options.connections,
    // autocannon 的 duration 单位是秒；对外仍收毫秒，免得调用点为了换尺子改一遍参数。
    duration: options.durationMilliseconds / 1000,
    pipelining: 1,
    workers: options.workers ?? defaultWorkers,
    warmup: {
      connections: options.connections,
      duration: options.warmupMilliseconds / 1000,
    },
    ...(options.headers === undefined ? {} : { headers: options.headers }),
  });
  // requests 直方图记的是「每秒完成数」的样本序列，均值即吞吐；不自己用 total/duration 算，
  // 那样会把预热与收尾的边界样本算进去。
  const requestsPerSecond = result.requests.average;
  return {
    requests: result.requests.total,
    requestsPerSecond,
    microsecondsPerRequest: requestsPerSecond === 0 ? 0 : 1_000_000 / requestsPerSecond,
    p50Milliseconds: result.latency.p50,
    p99Milliseconds: result.latency.p99,
    // 四类都算失败：非 2xx 说明被测目标答错了，后三类说明这次测量本身不可信。
    failures: result.non2xx + result.errors + result.timeouts + result.mismatches,
  };
}

/**
 * 跑 N 轮取中位数那一轮（#338）。
 *
 * 取整轮而不是逐字段取中位数：逐字段合出来的结果是一组互不自洽的数（吞吐来自 A 轮、p99 来自
 * B 轮），读者据此算 µs/req 会算出一个哪一轮都没发生过的值。
 */
export async function runLoad(url: string, options: LoadOptions): Promise<LoadResult> {
  const repetitions = options.repetitions ?? defaultRepetitions;
  const samples: Omit<LoadResult, "spreadRatio">[] = [];
  for (let round = 0; round < repetitions; round += 1) {
    samples.push(await runOnce(url, options));
  }
  samples.sort((left, right) => left.requestsPerSecond - right.requestsPerSecond);
  const lowest = samples[0];
  const highest = samples[samples.length - 1];
  const median = samples[Math.floor(samples.length / 2)];
  if (median === undefined || lowest === undefined || highest === undefined) {
    throw new Error("a load measurement must produce at least one sample");
  }
  return {
    ...median,
    spreadRatio:
      median.requestsPerSecond === 0
        ? 0
        : (highest.requestsPerSecond - lowest.requestsPerSecond) / median.requestsPerSecond,
  };
}

export interface GeneratorCalibration {
  readonly singleWorker: number;
  readonly multiWorker: number;
  readonly shortfallRatio: number;
  /** 判定用的噪声下限，即两轮校准里较大的那个 spread。 */
  readonly noiseFloor: number;
  readonly constrained: boolean;
}

/**
 * 校准发压侧（#338 的核心教训）：拿本次跑分里**最快的那个目标**，分别用缺省线程数和更多线程
 * 各测一遍。加线程之后吞吐显著上去了，说明缺省配置下发压侧就是瓶颈，整张表都不可采信。
 *
 * 这一步取代了「拍一个上限常量再比大小」的写法。那个写法有两个毛病：常量是猜的，而且它在
 * 机器换代或被测目标变快之后会静默失效——恰好是这次要修的那类错误的翻版。校准是就地实测，
 * 不依赖任何先验数字。
 */
export async function calibrateGenerator(
  url: string,
  options: LoadOptions,
): Promise<GeneratorCalibration> {
  const single = await runLoad(url, { ...options, workers: defaultWorkers });
  const multi = await runLoad(url, { ...options, workers: calibrationWorkers });
  const shortfallRatio =
    multi.requestsPerSecond === 0
      ? 0
      : (multi.requestsPerSecond - single.requestsPerSecond) / multi.requestsPerSecond;
  // 判据是「差值超过这次测量自己的噪声」，不是一个拍出来的百分比。写死阈值的话，机器一忙
  // 就会因为噪声误报，机器一闲又可能漏报真约束——而两轮校准的 spread 正好就是当下的噪声
  // 幅度，用它当分界不依赖任何先验数字。
  const noiseFloor = Math.max(single.spreadRatio, multi.spreadRatio);
  return {
    singleWorker: single.requestsPerSecond,
    multiWorker: multi.requestsPerSecond,
    shortfallRatio,
    noiseFloor,
    constrained: shortfallRatio > noiseFloor,
  };
}

export function formatCalibration(calibration: GeneratorCalibration): string {
  const floor = `${(calibration.noiseFloor * 100).toFixed(1)}%`;
  const gain = calibration.shortfallRatio * 100;
  // 负值 = 加线程反而更慢，说的是「发压侧余量充足到 worker 开销都盖过收益」。直接印
  // `差 -5.0%，未超过噪声下限 3.6%` 会被读成算错了，所以两个方向分开说。
  const verdict = calibration.constrained
    ? `发压侧受限：加到 ${calibrationWorkers} 线程后吞吐涨了 ${gain.toFixed(1)}%，超过本次噪声下限 ${floor}——缺省的 ${defaultWorkers} 线程不够，下面的数字要按下限看`
    : gain < 0
      ? `发压侧不是瓶颈：加到 ${calibrationWorkers} 线程反而慢了 ${Math.abs(gain).toFixed(1)}%（worker 开销盖过收益）`
      : `发压侧不是瓶颈：加到 ${calibrationWorkers} 线程只快 ${gain.toFixed(1)}%，未超过本次噪声下限 ${floor}`;
  return `发压校准（打本表最快的目标）：${defaultWorkers} worker ${calibration.singleWorker.toFixed(0)} req/s vs ${calibrationWorkers} workers ${calibration.multiWorker.toFixed(0)} req/s —— ${verdict}`;
}

export function formatRow(label: string, result: LoadResult, baseline?: LoadResult): string {
  const rps = result.requestsPerSecond;
  const relative =
    baseline === undefined
      ? ""
      : ` (${((rps / baseline.requestsPerSecond) * 100).toFixed(1)}% of baseline)`;
  // p99 低于 autocannon 的 1ms 分辨率时印 `<1` 而不是 `0`：写 0 会被读成「零延迟」，
  // 而事实是这一列在亚毫秒段没有分辨率。
  const p99 = result.p99Milliseconds < 1 ? "<1 ms" : `${result.p99Milliseconds.toFixed(0)} ms`;
  return [
    `| ${label} `,
    `| ${rps.toFixed(0)} req/s `,
    `| ${result.microsecondsPerRequest.toFixed(2)} µs `,
    `| ±${(result.spreadRatio * 100).toFixed(1)}% `,
    `| ${p99} `,
    `| ${result.failures} |${relative}`,
  ].join("");
}
