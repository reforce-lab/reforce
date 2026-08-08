import { Writable } from "node:stream";
import { normalizeTerminalOutput } from "@reforce/tooling-testing";
import { describe, expect, test } from "vitest";
import { renderStartupSummary, type StartupSummary } from "@/startup-summary";

const stream = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});

const summary: StartupSummary = {
  startedAt: 1_700_000_000_000,
  readyAt: 1_700_000_000_012,
  sections: [
    { label: "web", facts: ["4 controllers", "37 routes"], expandWith: "reforce explain routes" },
    { label: "beans", facts: ["61 singletons", "3 request-scoped"] },
  ],
};

function human(options: { readonly columns?: number } = {}): readonly string[] {
  return renderStartupSummary(summary, { stream, mode: "human", ...options }).map((line) =>
    normalizeTerminalOutput(line),
  );
}

describe("startup summary, human mode", () => {
  // 折叠必带出口：只折叠不给展开命令，读者只能去翻源码——那等于把信息藏起来还假装简洁。
  test("prints the expand command next to a folded section", () => {
    expect(human()[0]).toContain("reforce explain routes");
  });

  test("keeps every fact of a section on its line", () => {
    expect(human()[0]).toContain("4 controllers · 37 routes");
  });

  // 颜色不得是级别的唯一通道：管道里、NO_COLOR 下、色盲用户那里颜色都可能不存在。
  test("writes the level word itself, not only a colour", () => {
    expect(human().every((line) => line.startsWith("info "))).toBe(true);
  });

  test("closes with the elapsed time relative to process start", () => {
    expect(human().at(-1)).toContain("+12ms");
  });

  test("aligns the labels into one column", () => {
    const [first, second] = human();
    const factsColumn = (line: string) => line.indexOf("·") >= 0 || line.length > 0;

    expect(factsColumn(first ?? "")).toBe(true);
    expect((first ?? "").indexOf("4 controllers")).toBe((second ?? "").indexOf("61 singletons"));
  });

  // 伪 tty 报 columns 0、非 TTY 报 undefined，两个退化值都不能让标签塌成空串。
  test("still renders a usable label when the terminal reports no width", () => {
    expect(human({ columns: 0 })[0]).toContain("web");
  });

  test("keeps the distinguishing tail when a label overflows a narrow terminal", () => {
    const narrow = renderStartupSummary(
      { ...summary, sections: [{ label: "services.orders.gateway", facts: ["1"] }] },
      { stream, mode: "human", columns: 24 },
    ).map((line) => normalizeTerminalOutput(line));

    expect(narrow[0]).toContain("…");
    expect(narrow[0]).toContain("gateway");
  });
});

describe("startup summary, structured mode", () => {
  // 相对时间只在「人正盯着这次启动」时有意义；进了日志系统之后 +12ms 相对于什么无从得知。
  test("carries a full ISO timestamp instead of a relative one", () => {
    const [line] = renderStartupSummary(summary, { stream, mode: "json" });

    expect(JSON.parse(line ?? "{}").timestamp).toBe("2023-11-14T22:13:20.012Z");
  });

  test("emits one parseable record per section", () => {
    const lines = renderStartupSummary(summary, { stream, mode: "json" });

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      name: "reforce.startup",
      message: "web",
      facts: ["4 controllers", "37 routes"],
      expandWith: "reforce explain routes",
    });
  });

  test("omits the expand key for a section that has no expansion", () => {
    const lines = renderStartupSummary(summary, { stream, mode: "json" });

    expect("expandWith" in JSON.parse(lines[1] ?? "{}")).toBe(false);
  });
});
