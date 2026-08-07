// 栈帧过滤（RFC 0011 D6，#242）。
//
// D6 是两半，此前只落了后半：#247 做完了「栈帧**重定位**」（source map 五环，让帧指回源码），
// 但「默认只显示应用帧、node 与 reforce 内部帧折叠成一行」一直没做。C2 的崩溃接管把整条裸栈
// 写进了 stderr，于是 RFC 说的「Node 默认 40 帧里 35 帧是噪音」现在真的摆在用户面前。
//
// 折叠的是 **node 内部与 reforce 内部**两类，逐字照 D6，不顺手把别的 node_modules 也折掉：
// 第三方库的帧常常正是根因所在（序列化器抛了、驱动抛了），把它藏起来是在帮倒忙。

/** 折叠行的展开出口（不变量 4：折叠必带计数与展开路径）。 */
const expandHint = "--verbose to show";

// 帧的形状是 `    at fn (location)` 或 `    at location`。判 location 而不是判函数名——
// 函数名可以是用户起的任何东西，位置不会骗人。
const framePattern = /^\s+at\s/u;

// 仓库内自跑（packages/<name>/dist）那一半按**框架包名单**认，不认任意 `packages/*/dist`：
// 用户自己的 monorepo 完全可能叫 packages/orders/dist，把用户帧折叠掉正是「第三方帧常常是
// 根因」要防的那种帮倒忙。名单是本仓运行期会出现在栈上的包的封闭集合；新增运行期包时
// 补一行，漏补的代价只是那个包的帧不折叠——偏吵，不偏静默。
const frameworkPackageDirectories = [
  "cli",
  "config",
  "core",
  "logging",
  "logging-pino",
  "primitives",
  "runtime",
  "transaction",
  "web",
  "web-fastify",
  "web-hono",
  "web-node",
] as const;

const frameworkDistPattern = new RegExp(
  `[/\\\\]packages[/\\\\](?:${frameworkPackageDirectories.join("|")})[/\\\\]dist[/\\\\]`,
  "u",
);

function isInternalFrame(frame: string): boolean {
  // `node:internal/...` / `node:fs` 一类是 Node 自己的模块标识；`(node:` 覆盖带函数名的形态。
  if (frame.includes("(node:") || /\s+at\s+node:/u.test(frame)) {
    return true;
  }
  // 装出来的 reforce 住在 node_modules/@reforce/*；仓库内自跑时住在 packages/<名单>/dist。
  // 两种布局都要认，否则「本地跑不复现折叠」会让人以为它没生效。
  return frame.includes("node_modules/@reforce/") || frameworkDistPattern.test(frame);
}

function foldedLine(count: number): string {
  return `    … ${count} ${count === 1 ? "frame" : "frames"} in node/reforce (${expandHint})`;
}

/**
 * 把一条栈里连续的 node/reforce 帧折成一行带计数的省略行。
 *
 * 只作用于**人读**输出。json 模式下的 `err.stack` 保持完整——那一份的读者是采集系统，
 * 折叠对它只是丢信息（不变量 3 说的是「同一份事件三种模式」，折叠是渲染，不是字段差异）。
 */
export function foldStackFrames(stack: string, verbose = false): string {
  if (verbose) {
    return stack;
  }
  const lines = stack.split("\n");
  const output: string[] = [];
  let run = 0;
  const flush = () => {
    if (run > 0) {
      output.push(foldedLine(run));
      run = 0;
    }
  };
  for (const line of lines) {
    // 非帧行（消息本身、`Caused by:` 之类）原样留下，并且要先把攒着的折叠吐出去，
    // 否则折叠行会跑到它后面，读起来像是消息之后才有那些帧。
    if (!framePattern.test(line)) {
      flush();
      output.push(line);
      continue;
    }
    if (isInternalFrame(line)) {
      run += 1;
      continue;
    }
    flush();
    output.push(line);
  }
  flush();
  return output.join("\n");
}

/** 取错误的栈；没有栈的（抛了个字符串、抛了个对象）退回它的字符串形态。 */
export function stackOf(error: unknown): string {
  return error instanceof Error && typeof error.stack === "string" ? error.stack : String(error);
}
