import type { Writable } from "node:stream";
import { style } from "@reforce/runtime/terminal";

// 启动 banner（RFC 0011 D2，#242）：**一行**，不做 ASCII 画。
//
// 它回答的是「我到底在跑哪个版本」——这在 bug 报告里是第一个要问的问题，而在它存在之前
// 用户唯一的答案是去翻 node_modules。一行就够，多一行都是在跟真正的启动输出抢版面。
//
// 只在 human 模式打：short 是给按行 grep 的脚本读的，json 是给采集系统读的，两边都不需要
// 一条「这是谁」的招牌，还要为它多写一条跳过规则。

export interface BannerFacts {
  /** CLI 自己的版本；取不到时给 undefined，这一段整个省掉而不是打一个假的。 */
  readonly version?: string;
  readonly command: string;
  /** 缺省 `process.versions.node`。 */
  readonly nodeVersion?: string;
}

// 打完整的 node 版本而不是 RFC 示意图里的 `node 26.5`：patch 位承载真实的行为差异（本仓的
// 注释里就有好几处「Node 26.5.1 本地实测」），而这一行有的是地方。
export function renderBanner(facts: BannerFacts, stream: Writable): string {
  const segments = [
    style(["bold"], `reforce${facts.version === undefined ? "" : ` ${facts.version}`}`, stream),
    `node ${facts.nodeVersion ?? process.versions.node}`,
    facts.command,
  ];
  return style(["dim"], segments.join("   "), stream);
}
