import { readdirSync, statSync } from "node:fs";

export type TargetDirectoryState = "absent" | "empty" | "not-empty" | "not-a-directory";

/**
 * 清洗用户输入的目录：去掉首尾空白、Windows 文件名非法字符，以及尾部斜杠。
 *
 * 尾斜杠是最常撞上的一个——`create-reforce my-app/` 是很自然的敲法（shell 补全就会补出
 * 斜杠），不处理的话它会一路带到 basename 和提示文本里。非法字符列表与 create-vite 一致。
 */
export function normalizeDirectoryInput(input: string): string {
  return input
    .trim()
    .replace(/[<>:"\\|?*]/g, "")
    .replace(/\/+$/g, "");
}

/**
 * 同步实现是有意的：clack 的 validate 回调是同步的，异步版本会逼出第二份同样的判定逻辑。
 * 这是 CLI 启动期的一次性检查，没有并发要让路。
 *
 * 交互期用它做即时反馈，落盘前再查一次——两次之间用户可能自己动了目录，而覆盖别人的
 * 文件不可逆。
 */
export function inspectTargetDirectory(path: string): TargetDirectoryState {
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return "absent";
    }
    // 路径中间某一段是文件时（`create-reforce some-file/app`）stat 报 ENOTDIR。它和
    // "存在但不是目录"是同一类用户错误，走同一条友好提示，不该以异常冒到顶层。
    if (code === "ENOTDIR") {
      return "not-a-directory";
    }
    throw error;
  }
  if (!stats.isDirectory()) {
    return "not-a-directory";
  }
  const entries = readdirSync(path);
  // 只有 .git 的目录按空处理：`git init myapp && create-reforce myapp`、或先 clone 一个空仓库
  // 再灌代码，都是常规流程，不该被当成"目录非空"挡住。create-vite 同样这么判。
  if (entries.length === 0 || (entries.length === 1 && entries[0] === ".git")) {
    return "empty";
  }
  return "not-empty";
}

// 只描述**无法继续**的状态。目录非空不在此列——那是可以让用户选择如何处理的情况，
// 由调用方决定，不是一条死路。
export function describeUnusableDirectory(path: string): string | undefined {
  if (inspectTargetDirectory(path) === "not-a-directory") {
    return `${path} 已存在，但不是目录。`;
  }
  return undefined;
}
