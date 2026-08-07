import { Readable, Writable } from "node:stream";

// 键序列：clack 走 readline 的 keypress，方向键是 CSI 序列。
export const KEY = {
  enter: String.fromCharCode(13),
  tab: String.fromCharCode(9),
  right: `${String.fromCharCode(27)}[C`,
  left: `${String.fromCharCode(27)}[D`,
  backspace: String.fromCharCode(127),
} as const;

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[a-zA-Z]`, "g");

export interface PromptRun {
  readonly value: string | symbol;
  /** 最后一帧（提交后）的可见文本，样式码已剥离。 */
  readonly frame: string;
  /** 回车之前的最后一帧——要断言输入过程中的渲染（如灰字补全）只能看这个。 */
  readonly frameBeforeSubmit: string;
}

function extractLastFrame(chunks: readonly string[]): string {
  const joined = chunks.join("");
  const frames = joined.split(new RegExp(`${ESC}\\[999D`));
  return (frames.at(-1) ?? joined)
    .replace(ANSI, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .join("\n");
}

/**
 * 用内存流驱动一个 clack prompt，不需要真 TTY。
 *
 * clack 只在 isTTY 为真时进入 raw 模式并渲染，所以这里在假流上把它标成 TTY——这是驱动
 * 交互式 prompt 做断言的唯一办法，pty 在 CI 上既装不了也喂不进按键。
 */
export async function drivePrompt(
  run: (io: { readonly input: Readable; readonly output: Writable }) => Promise<string | symbol>,
  keystrokes: readonly string[],
): Promise<PromptRun> {
  const chunks: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  Object.assign(output, { isTTY: true, columns: 60 });
  const input = new Readable({ read() {} });
  Object.assign(input, { isTTY: true, setRawMode: () => {} });

  const promise = run({ input, output });
  let delay = 40;
  for (const key of keystrokes) {
    setTimeout(() => input.push(key), delay);
    delay += 40;
  }
  // 回车会把画面切成 submit 帧，所以要在按下它之前先把输入中的画面截下来。
  let chunksBeforeSubmit: readonly string[] = [];
  setTimeout(() => {
    chunksBeforeSubmit = [...chunks];
    input.push(KEY.enter);
  }, delay + 60);

  const value = await promise;
  return {
    value,
    frame: extractLastFrame(chunks),
    frameBeforeSubmit: extractLastFrame(chunksBeforeSubmit),
  };
}
