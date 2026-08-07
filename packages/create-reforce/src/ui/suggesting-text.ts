import type { Readable, Writable } from "node:stream";
import { TextPrompt } from "@clack/core";
import { S_BAR, S_BAR_END, symbol } from "@clack/prompts";
import pc from "picocolors";

export interface SuggestingTextOptions {
  readonly message: string;
  /** 灰字建议值。空输入直接回车即取它；输入是它的前缀时，按 Tab / → 补全。 */
  readonly suggestion: string;
  readonly validate?: (value: string) => string | undefined;
  readonly input?: Readable;
  readonly output?: Writable;
}

/**
 * 建议值里还没被打出来的那一截；输入不是建议值前缀时为空串。
 *
 * 空输入返回**整条**建议：此时屏幕上灰字铺满一整条，Tab 却什么都不做，是没道理的。
 */
export function completionOf(suggestion: string, typed: string): string {
  if (!suggestion.startsWith(typed)) {
    return "";
  }
  return suggestion.slice(typed.length);
}

/** 用户没打字时，回车与校验都按建议值算。 */
function resolveValue(suggestion: string, typed: string | undefined): string {
  const input = typed ?? "";
  return input.length === 0 ? suggestion : input;
}

// clack 的 State 类型没有单独导出，从 symbol() 的签名取回来。
type PromptState = Parameters<typeof symbol>[0];

// 帧结构照抄 @clack/prompts 的 text()，这样它和同一屏里的 select / confirm 对得齐。
function renderFrame(input: {
  readonly message: string;
  readonly state: PromptState;
  readonly body: string;
  readonly value: string;
  readonly error: string;
}): string {
  const title = `${pc.gray(S_BAR)}\n${symbol(input.state)}  ${input.message}\n`;
  if (input.state === "error") {
    return `${title.trim()}\n${pc.yellow(S_BAR)}  ${input.body}\n${pc.yellow(S_BAR_END)}  ${pc.yellow(input.error)}\n`;
  }
  if (input.state === "submit") {
    return `${title}${pc.gray(S_BAR)}  ${pc.dim(input.value)}`;
  }
  if (input.state === "cancel") {
    return `${title}${pc.gray(S_BAR)}  ${pc.strikethrough(pc.dim(input.value))}\n${pc.gray(S_BAR)}`;
  }
  return `${title}${pc.cyan(S_BAR)}  ${input.body}\n${pc.cyan(S_BAR_END)}\n`;
}

/**
 * 带 inline 补全的文本输入：像 fish shell 那样把还没打的部分用灰字续在光标后，Tab 一键
 * 补全（光标在行尾时 → 也可以），打了不匹配的字符就自动收起，什么都不打直接回车即取建议值。
 *
 * 为什么自己写：@clack/prompts 的 text() 两种模式都不是这个行为——placeholder 是纯提示，
 * 用户一打字整条就消失（逐帧实测过，打匹配的首字母也照样消失；create-vite bundle 里那份
 * render 与 clack 逐字一致，所以它也一样），而 initialValue 是真值预填，想换名字得先删掉
 * 十几个字符。inline 补全两头的好处都要：默认值零打字可用，想改直接开打不用删。
 *
 * 代价是继承 @clack/core 的 TextPrompt 并调用 protected 的 _setUserInput——库的内部面。
 * 升级 @clack/core 时回来跑 it/suggesting-text.spec.ts，那套用例把这里的行为钉死了。
 */
class SuggestingTextPrompt extends TextPrompt {
  // 上一次按键处理完时的光标位置，用来判断 → 到底是"把光标往右挪"还是"光标已经在行尾"。
  private previousCursor = 0;

  constructor(options: SuggestingTextOptions) {
    const { suggestion, message } = options;
    super({
      // 校验必须看**回车后真正会提交的值**：@clack/core 在 onKeypress 里先跑 validate，
      // 再 emit("finalize")（core 1.4.3 index.mjs:289 与 :295）。空输入取建议值这件事
      // 只写在 finalize 里就太晚了——校验拿到的是空串，于是"目录不能为空"会把用户按下的
      // 第一个回车直接顶回去，灰字承诺的默认值一次都用不上。
      validate:
        options.validate === undefined
          ? undefined
          : (value) => options.validate?.(resolveValue(suggestion, value)),
      input: options.input,
      output: options.output,
      render() {
        const typed = this.userInput ?? "";
        const body =
          typed.length === 0
            ? pc.dim(suggestion)
            : `${this.userInputWithCursor}${pc.dim(completionOf(suggestion, typed))}`;
        return renderFrame({
          message,
          state: this.state,
          body,
          value: this.value ?? "",
          error: this.error,
        });
      },
    });
    this.on("key", (_char, info) => {
      const cursorBeforeKey = this.previousCursor;
      this.previousCursor = this.cursor;
      if (info?.name !== "tab" && info?.name !== "right") {
        return;
      }
      // → 首先是光标键。readline 先于本回调处理按键，所以"光标动了"就说明它刚才不在
      // 行尾，这一下是移动而不是补全——照 fish 的规矩，光标挪到行尾后再按一次才补全。
      // 少了这道判断，"打 my- 再按 ← 、按 →"会把输入整个换成 my-reforce-app（实测）。
      if (info.name === "right" && cursorBeforeKey !== this.cursor) {
        return;
      }
      if (completionOf(suggestion, this.userInput ?? "").length === 0) {
        return;
      }
      // 必须先清空 readline 的行缓冲：_setUserInput(v, true) 内部是 rl.write(v)，而
      // readline 的 write 是**追加**。直接写会得到 "my-" + "my-reforce-app"，而且下一次
      // 按键时 onKeypress 会拿 rl.line 覆盖回来，错误就固化了（实测症状：my-my-reforce-ap）。
      this._clearUserInput();
      this._setUserInput(suggestion, true);
    });
    // 空输入直接回车时取建议值——这是 placeholder 模式唯一强过 initialValue 的地方，
    // 换成 inline 补全之后不能把它弄丢。上面的 validate 包装与这里必须同一条规则。
    this.on("finalize", () => {
      this.value = resolveValue(suggestion, this.userInput);
    });
  }
}

/** 返回用户输入；用户取消时返回 clack 的 cancel symbol，与其他 prompt 的约定一致。 */
export async function suggestingText(options: SuggestingTextOptions): Promise<string | symbol> {
  const result = await new SuggestingTextPrompt(options).prompt();
  // Prompt<string>.prompt() 的返回类型含 undefined（基类为无值 prompt 留的口子），
  // TextPrompt 恒有字符串值，这里把它收敛掉而不是让 undefined 漏给调用方。
  return result ?? "";
}
