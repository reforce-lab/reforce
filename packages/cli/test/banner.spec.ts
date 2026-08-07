import { Writable } from "node:stream";
import { describe, expect, test } from "vitest";
import { renderBanner } from "@/banner";

// D2（RFC 0011，#242）：banner **一行**，不做 ASCII 画。它回答的是「我到底在跑哪个版本」，
// 而在它存在之前用户唯一的答案是去翻 node_modules。

// 非 TTY：styleText 按目标流判定是否上色，这里拿到的是裸文本，断言因此稳定。
const piped = new Writable({ write: (_chunk, _encoding, done) => done() });

describe("renderBanner", () => {
  test("puts the version, the node version and the command on one line", () => {
    const banner = renderBanner({ version: "0.1.0", command: "dev", nodeVersion: "26.5.1" }, piped);

    expect(banner).toBe("reforce 0.1.0   node 26.5.1   dev");
    expect(banner).not.toContain("\n");
  });

  // 版本读不出来时省掉那一段，不打 "unknown" 也不打 "0.0.0"：一个假版本会把 bug 报告
  // 直接引到错误的提交上，而缺了这一段读者至少知道要另外去问。
  test("drops the version segment when it could not be read", () => {
    expect(renderBanner({ command: "build", nodeVersion: "26.5.1" }, piped)).toBe(
      "reforce   node 26.5.1   build",
    );
  });
});
