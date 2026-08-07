import { describe, expect, test } from "vitest";
import { foldStackFrames, stackOf } from "@/stack-frames";

// D6 前半句（RFC 0011，#242）：默认只显示应用帧，node 与 reforce 内部帧折叠成一行带计数的
// 省略行，--verbose 展开。#247 只落了后半句（栈帧重定位），这一半一直没做，而 C2 的崩溃接管
// 把整条裸栈写进了 stderr——「40 帧里 35 帧是噪音」因此真的摆在用户面前。

const applicationFrame = "    at OrderService.place (/srv/app/src/order.service.ts:14:11)";
const anotherApplicationFrame = "    at handler (/srv/app/src/routes.ts:9:3)";
const nodeFrame =
  "    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)";
const bareNodeFrame = "    at node:internal/main/run_main_module:36:49";
const reforceFrame =
  "    at BoundLogger.info (/srv/app/node_modules/@reforce/logging/dist/index.js:88:5)";
const workspaceReforceFrame =
  "    at WebEngine.start (/home/dev/reforce/packages/web-node/dist/engine.js:41:9)";
const thirdPartyFrame = "    at write (/srv/app/node_modules/pino/lib/tools.js:120:9)";

describe("foldStackFrames", () => {
  test("folds a run of node and reforce frames into one counted line", () => {
    const stack = ["Error: boom", applicationFrame, nodeFrame, bareNodeFrame, reforceFrame].join(
      "\n",
    );

    expect(foldStackFrames(stack)).toBe(
      ["Error: boom", applicationFrame, "    … 3 frames in node/reforce (--verbose to show)"].join(
        "\n",
      ),
    );
  });

  test("counts a single folded frame in the singular", () => {
    const stack = ["Error: boom", applicationFrame, nodeFrame].join("\n");

    expect(foldStackFrames(stack)).toContain("… 1 frame in node/reforce");
  });

  // 折叠必带展开路径（不变量 4）。只给计数等于告诉读者「这里还有东西，但别问」。
  test("every folded line carries the command that expands it", () => {
    const stack = ["Error: boom", applicationFrame, nodeFrame].join("\n");

    expect(foldStackFrames(stack)).toContain("--verbose to show");
  });

  test("verbose returns the stack untouched", () => {
    const stack = ["Error: boom", applicationFrame, nodeFrame, reforceFrame].join("\n");

    expect(foldStackFrames(stack, true)).toBe(stack);
  });

  // 两段噪音被应用帧隔开时是两次折叠，各自带自己的计数——合并成一个总数会让人以为它们
  // 是连续的，那正好把「哪一段应用代码在中间」这条最有用的信息抹掉。
  test("two runs separated by an application frame fold separately", () => {
    const stack = [
      "Error: boom",
      nodeFrame,
      applicationFrame,
      reforceFrame,
      workspaceReforceFrame,
    ].join("\n");

    expect(foldStackFrames(stack)).toBe(
      [
        "Error: boom",
        "    … 1 frame in node/reforce (--verbose to show)",
        applicationFrame,
        "    … 2 frames in node/reforce (--verbose to show)",
      ].join("\n"),
    );
  });

  // 仓内自跑那一半按框架包名单认：用户自己的 monorepo 完全可能叫 packages/orders/dist，
  // 把用户帧折叠掉正是「第三方帧常常是根因」要防的那种帮倒忙。
  test("keeps a user monorepo packages/*/dist frame unfolded", () => {
    const userMonorepoFrame =
      "    at OrderRepo.save (/srv/app/packages/orders/dist/order-repo.js:12:7)";
    const stack = ["Error: boom", userMonorepoFrame, nodeFrame].join("\n");

    expect(foldStackFrames(stack)).toBe(
      ["Error: boom", userMonorepoFrame, "    … 1 frame in node/reforce (--verbose to show)"].join(
        "\n",
      ),
    );
  });

  // 别的 node_modules **不折**。D6 逐字说的是 node 与 reforce 两类，而第三方库的帧常常正是
  // 根因所在（序列化器抛了、驱动抛了）——把它藏起来是在帮倒忙。
  test("keeps third-party frames that are neither node nor reforce", () => {
    const stack = ["Error: boom", thirdPartyFrame, nodeFrame].join("\n");

    expect(foldStackFrames(stack)).toBe(
      ["Error: boom", thirdPartyFrame, "    … 1 frame in node/reforce (--verbose to show)"].join(
        "\n",
      ),
    );
  });

  // 非帧行原样留下，且折叠行不许越过它——越过之后读起来就像那些帧发生在消息之后。
  test("a non-frame line flushes the pending fold before it", () => {
    const stack = ["Error: boom", nodeFrame, "Caused by: Error: inner", applicationFrame].join(
      "\n",
    );

    expect(foldStackFrames(stack)).toBe(
      [
        "Error: boom",
        "    … 1 frame in node/reforce (--verbose to show)",
        "Caused by: Error: inner",
        applicationFrame,
      ].join("\n"),
    );
  });

  test("a stack with nothing to fold is returned unchanged", () => {
    const stack = ["Error: boom", applicationFrame, anotherApplicationFrame].join("\n");

    expect(foldStackFrames(stack)).toBe(stack);
  });
});

describe("stackOf", () => {
  test("takes the stack of an error", () => {
    expect(stackOf(new Error("boom"))).toContain("Error: boom");
  });

  // 抛了个不是 Error 的东西时不能返回 undefined 再让调用方去处理：那条路径上多一个分支就
  // 多一次「崩溃时把崩溃报告写崩」的机会。
  test("falls back to the string form of a thrown non-error", () => {
    expect(stackOf("plain string")).toBe("plain string");
  });
});
