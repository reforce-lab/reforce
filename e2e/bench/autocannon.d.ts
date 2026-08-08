// autocannon 8.0.0 的手写最小声明（#338）。
//
// 它不自带类型（package.json 没有 types / typings 字段，2026-08-08 核对 registry），而社区
// @types/autocannon 落后一个大版本（只到 7.12.7）——装它等于引进一份与实测行为不符的声明。
// 因此只声明本仓真正用到的字段，每条都对着 node_modules/autocannon 的源码核过：
//
//   - `warmup` 走 lib/init.js:40 的 runWithWarmup，它把 opts.warmup 整个铺到主 opts 上再跑
//     一轮丢弃结果。程序化调用必须写全名 connections / duration：`-c` / `-d` 只是 CLI 的
//     subarg 别名，映射发生在 lib/subargAliases.js，走不到程序化入口。
//   - 结果的三个直方图由 lib/aggregateResult.js:69 组装：`requests.total` 是完成请求总数、
//     `requests.average` 是「每秒请求数」这个样本序列的均值（即吞吐），`latency.*` 单位毫秒。
//   - 返回值不是真 Promise：lib/init.js:25 的 run() 返回一个 EventEmitter，把 promise 的
//     then / catch 绑上去。所以类型写 PromiseLike——await 得到的正是它，而本仓只 await 它。
declare module "autocannon" {
  /** hdr-histogram-percentiles-obj 的形状，只列用到的键。 */
  interface AutocannonHistogram {
    readonly average: number;
    readonly min: number;
    readonly max: number;
    /** 该直方图的累计量：requests 上是完成请求总数，throughput 上是总字节数。 */
    readonly total: number;
    readonly p50: number;
    readonly p99: number;
  }

  interface AutocannonWarmup {
    readonly connections?: number;
    /** 秒。 */
    readonly duration?: number;
  }

  interface AutocannonOptions {
    readonly url: string;
    readonly connections?: number;
    /** 秒。 */
    readonly duration?: number;
    /** 每连接同时在途的请求数；缺省 1，即一问一答。 */
    readonly pipelining?: number;
    /** 发压 worker 线程数；缺省 1（单进程）。结果由 lib/aggregateResult.js 合并。 */
    readonly workers?: number;
    readonly headers?: Readonly<Record<string, string>>;
    /** 给了就先跑一轮丢弃结果的预热，再跑正式一轮。 */
    readonly warmup?: AutocannonWarmup;
  }

  interface AutocannonResult {
    readonly requests: AutocannonHistogram;
    readonly latency: AutocannonHistogram;
    /** 实际计时时长，秒。 */
    readonly duration: number;
    readonly errors: number;
    readonly timeouts: number;
    /** 响应体与 expectBody 不符的次数；本仓不用 expectBody，恒为 0。 */
    readonly mismatches: number;
    readonly non2xx: number;
  }

  const autocannon: (options: AutocannonOptions) => PromiseLike<AutocannonResult>;
  export default autocannon;
}
