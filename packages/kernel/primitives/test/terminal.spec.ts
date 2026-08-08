import { Writable } from "node:stream";
import { describe, expect, test } from "vitest";
import { columnsOf, isInteractive, style, truncateStart } from "@/terminal";

function sink(properties: Readonly<Record<string, unknown>> = {}): Writable {
  return Object.assign(
    new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
    properties,
  );
}

describe("terminal width", () => {
  test("reports a real terminal width", () => {
    expect(columnsOf(sink({ columns: 120 }))).toBe(120);
  });

  // 伪 tty（script -qec 之类）把 columns 报成 0；只判 undefined 会让 0 一路传进截断函数，
  // 把每一行都截成空串。
  test("treats a pseudo terminal's zero width as unknown", () => {
    expect(columnsOf(sink({ columns: 0 }))).toBeUndefined();
  });

  test("treats an absent width as unknown", () => {
    expect(columnsOf(sink())).toBeUndefined();
  });
});

describe("terminal interactivity", () => {
  test("only a stream that declares isTTY is interactive", () => {
    expect([isInteractive(sink({ isTTY: true })), isInteractive(sink())]).toEqual([true, false]);
  });
});

describe("right-aligned truncation", () => {
  test("keeps a name that already fits", () => {
    expect(truncateStart("orders", 10)).toBe("orders");
  });

  test("keeps the distinguishing tail when a name overflows", () => {
    expect(truncateStart("services.orders.OrderService", 13)).toBe("…OrderService");
  });

  test("degrades to a single ellipsis at width one", () => {
    expect(truncateStart("orders", 1)).toBe("…");
  });

  test("returns nothing when there is no width to render into", () => {
    expect(truncateStart("orders", 0)).toBe("");
  });
});

// 就地剥 ANSI 而不是用 @reforce/tooling-testing 的 normalizeTerminalOutput（#347）：把它加进
// primitives 的 devDependencies 会成 turbo 环——`^build` 含 devDeps，而 tooling-testing 自己
// 依赖 primitives。一处断言不值得为它把最底层包的依赖图弄脏。
const escapeCharacter = String.fromCharCode(0x1b);
const ansiSequence = new RegExp(`${escapeCharacter}\\[[0-9;]*m`, "gu");

function stripAnsi(value: string): string {
  return value.replaceAll(ansiSequence, "");
}

describe("styling", () => {
  // 不断言「非 TTY 一律无色」：FORCE_COLOR 会压过流的 TTY 判定（Node 26 实测，CI 上常被设成
  // 1/3），那是用户显式要色，属正确行为。这里只钉住不变量——上色只加包裹，不动文本本身。
  test("keeps the text intact whatever the colour decision is", () => {
    expect(stripAnsi(style(["bold", "red"], "error", sink()))).toBe("error");
  });
});
