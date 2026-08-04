// HTTP 负载发生器（#153 基准）：进程内 fetch 并发循环。方法学：先预热再计时，固定并发
// worker 数、固定时长；每个请求记录一次延迟，结束后按排序数组取分位。它测的是"同机同法
// 下两个目标的相对差值"，不是标定绝对吞吐的压测（fetch 客户端本身有开销，但两侧同担）。

export interface LoadOptions {
  readonly connections: number;
  readonly warmupMilliseconds: number;
  readonly durationMilliseconds: number;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface LoadResult {
  readonly requests: number;
  readonly requestsPerSecond: number;
  readonly p50Milliseconds: number;
  readonly p99Milliseconds: number;
  readonly failures: number;
}

async function fetchLoop(
  url: string,
  headers: Readonly<Record<string, string>> | undefined,
  deadline: number,
  record: ((latency: number) => void) | undefined,
  failures: { count: number },
): Promise<number> {
  let completed = 0;
  while (performance.now() < deadline) {
    const started = performance.now();
    const response = await fetch(url, headers === undefined ? {} : { headers });
    await response.arrayBuffer();
    if (!response.ok) {
      failures.count += 1;
    }
    record?.(performance.now() - started);
    completed += 1;
  }
  return completed;
}

function percentile(sorted: readonly number[], ratio: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * ratio));
  const value = sorted[index];
  return value === undefined ? 0 : value;
}

export async function runLoad(url: string, options: LoadOptions): Promise<LoadResult> {
  const failures = { count: 0 };
  const warmupDeadline = performance.now() + options.warmupMilliseconds;
  await Promise.all(
    Array.from({ length: options.connections }, () =>
      fetchLoop(url, options.headers, warmupDeadline, undefined, failures),
    ),
  );
  failures.count = 0;
  const latencies: number[] = [];
  const record = (latency: number) => {
    latencies.push(latency);
  };
  const started = performance.now();
  const deadline = started + options.durationMilliseconds;
  const counts = await Promise.all(
    Array.from({ length: options.connections }, () =>
      fetchLoop(url, options.headers, deadline, record, failures),
    ),
  );
  const elapsedSeconds = (performance.now() - started) / 1000;
  const requests = counts.reduce((sum, count) => sum + count, 0);
  latencies.sort((left, right) => left - right);
  return {
    requests,
    requestsPerSecond: requests / elapsedSeconds,
    p50Milliseconds: percentile(latencies, 0.5),
    p99Milliseconds: percentile(latencies, 0.99),
    failures: failures.count,
  };
}

export function formatRow(label: string, result: LoadResult, baseline?: LoadResult): string {
  const rps = result.requestsPerSecond;
  const relative =
    baseline === undefined
      ? ""
      : ` (${((rps / baseline.requestsPerSecond) * 100).toFixed(1)}% of baseline)`;
  return [
    `| ${label} `,
    `| ${rps.toFixed(0)} req/s `,
    `| ${result.p50Milliseconds.toFixed(3)} ms `,
    `| ${result.p99Milliseconds.toFixed(3)} ms `,
    `| ${result.failures} |${relative}`,
  ].join("");
}
