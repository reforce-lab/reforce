import { describe, expect, test } from "vitest";
import { suggestingText } from "@/ui/suggesting-text";
import { drivePrompt, KEY } from "./support/prompt-driver";

const SUGGESTION = "my-reforce-app";

// clack 用反色块渲染光标位置，断言文本内容时要把它去掉。
function withoutCursor(frame: string): string {
  return frame.replace(/█/g, "");
}

function run(keystrokes: readonly string[]) {
  return drivePrompt(
    (io) => suggestingText({ message: "项目目录", suggestion: SUGGESTION, ...io }),
    keystrokes,
  );
}

// 这套用例把 inline 补全的行为钉死。它依赖 @clack/core 的内部面（protected _setUserInput
// 与 key 事件），升级 core 之后必须跑这里。
describe("suggestingText", () => {
  test("空输入直接回车取建议值", async () => {
    const { value } = await run([]);

    expect(value).toBe(SUGGESTION);
  });

  test("未输入时整条建议以灰字显示", async () => {
    const { frameBeforeSubmit } = await run([]);

    expect(frameBeforeSubmit).toContain(SUGGESTION);
  });

  test("输入是前缀时，剩余部分继续显示在光标后", async () => {
    const { frameBeforeSubmit } = await run(["m", "y", "-"]);

    // 实际渲染是 "my-█reforce-app"：█ 是光标块，灰字补全紧跟其后。剥掉光标块之后，
    // 屏幕上读到的就是完整的建议值。
    expect(withoutCursor(frameBeforeSubmit)).toContain(SUGGESTION);
  });

  test("输入不是前缀时补全收起，不再显示建议", async () => {
    const { frameBeforeSubmit, value } = await run(["x"]);

    expect(value).toBe("x");
    expect(frameBeforeSubmit).not.toContain(SUGGESTION);
  });

  test("Tab 把前缀补全成完整建议", async () => {
    const { value } = await run(["m", "y", "-", KEY.tab]);

    expect(value).toBe(SUGGESTION);
  });

  test("光标在行尾时 → 把前缀补全成完整建议", async () => {
    const { value } = await run(["m", "y", "-", KEY.right]);

    expect(value).toBe(SUGGESTION);
  });

  // → 首先是光标键：光标不在行尾时按它只能移动光标，不能把用户正在改的输入整条换掉。
  test("光标不在行尾时 → 只移动光标，不补全", async () => {
    const { value } = await run(["m", "y", "-", KEY.left, KEY.right]);

    expect(value).toBe("my-");
  });

  test("光标挪回行尾后再按一次 → 才补全", async () => {
    const { value } = await run(["m", "y", "-", KEY.left, KEY.right, KEY.right]);

    expect(value).toBe(SUGGESTION);
  });

  // 一个字没打时整条建议已经铺在屏幕上，Tab 却什么都不做说不过去。断言接着往下打的字
  // 落在建议值之后——只断言最终值区分不出"Tab 补全了"和"空输入回车兜底取了建议值"。
  test("空输入时 Tab 直接把建议值填进来", async () => {
    const { value } = await run([KEY.tab, "-", "2"]);

    expect(value).toBe(`${SUGGESTION}-2`);
  });

  test("输入不匹配时 Tab 不补全，保留用户输入", async () => {
    const { value } = await run(["x", KEY.tab]);

    expect(value).toBe("x");
  });

  test("补全后继续输入接在完整建议之后", async () => {
    const { value } = await run(["m", "y", "-", KEY.tab, "-", "2"]);

    expect(value).toBe(`${SUGGESTION}-2`);
  });

  test("打完整条建议后不重复补全", async () => {
    const { value } = await run([...SUGGESTION, KEY.tab]);

    expect(value).toBe(SUGGESTION);
  });

  test("退格后补全重新出现", async () => {
    const { value } = await run(["m", "y", "-", KEY.tab, KEY.backspace, KEY.tab]);

    expect(value).toBe(SUGGESTION);
  });

  // 回归（首屏就撞得到）：validate 跑在 finalize 之前，所以"空输入取建议值"这条规则
  // 必须在校验那一侧也成立。否则 `pnpm create reforce` 一进来直接回车，拿到的是
  // "请输入目录。"——而屏幕上那条灰字承诺的正好相反。
  test("拒绝空值的 validate 不会挡住空输入直接回车", async () => {
    const { value } = await drivePrompt(
      (io) =>
        suggestingText({
          message: "项目目录",
          suggestion: SUGGESTION,
          validate: (input) => (input.length === 0 ? "请输入目录。" : undefined),
          ...io,
        }),
      [],
    );

    expect(value).toBe(SUGGESTION);
  });

  test("validate 拒绝时不提交", async () => {
    const { value } = await drivePrompt(
      (io) =>
        suggestingText({
          message: "项目目录",
          suggestion: SUGGESTION,
          validate: (input) => (input === "bad" ? "不允许" : undefined),
          ...io,
        }),
      ["b", "a", "d", KEY.enter, KEY.backspace, KEY.backspace, KEY.backspace, "o", "k"],
    );

    expect(value).toBe("ok");
  });
});
