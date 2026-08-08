import { log, note, outro } from "@clack/prompts";
import pc from "picocolors";
import { ENGINE_KEYS } from "@/engines";
import { cdCommand, detectPackageManager, installCommand, runCommand } from "@/package-manager";

export const HELP_TEXT = `
${pc.bold("create-reforce")} — 生成一个 Reforce 应用

${pc.bold("用法")}
  pnpm create reforce [目录] [选项]

${pc.bold("选项")}
  --engine <${ENGINE_KEYS.join("|")}>   web 引擎（默认 hono）
  --lint                      生成 Biome 配置
  --no-lint                   不生成 Biome 配置
  -y, --yes                   全部取默认值，不交互
  -h, --help                  显示本帮助
      --version               显示版本

${pc.bold("示例")}
  pnpm create reforce
  pnpm create reforce my-api --engine fastify --no-lint
  pnpm create reforce my-api --yes
`.trim();

function directoryOf(file: string): string | undefined {
  const separator = file.lastIndexOf("/");
  return separator === -1 ? undefined : file.slice(0, separator);
}

// 生成物清单按目录分组，同目录的文件缩进对齐——十来个文件平铺成一列读不出结构。
// 根文件整体排在目录组之前：纯字母序会把 tsconfig.json 甩到 src/ 那一组后面，看起来
// 像是 src 里的东西。
function renderFileTree(files: readonly string[]): string {
  const rootFiles = files.filter((file) => directoryOf(file) === undefined);
  const nestedFiles = files.filter((file) => directoryOf(file) !== undefined);
  const lines: string[] = [...rootFiles];
  let currentDirectory: string | undefined;
  for (const file of nestedFiles) {
    const directory = directoryOf(file);
    if (directory !== currentDirectory) {
      lines.push(pc.dim(`${directory}/`));
      currentDirectory = directory;
    }
    lines.push(`  ${file.slice((directory?.length ?? 0) + 1)}`);
  }
  return lines.join("\n");
}

// 写盘实测中位数 3ms，整个进程 30-40ms：这里没有值得挂 spinner 的耗时步骤，硬加只能靠
// 人为 sleep 撑出来。真正缺的信息是"生成了什么"，所以列清单而不是演进度。
// 等 #241 发布落地、install 回到流程里，那一步才是真的需要进度反馈。
//
// 脚手架只写文件、不跑 install（#240）：装依赖的失败面——网络、registry、包管理器偏好——
// 不由这里承担。所以"下一步"必须把 install 摆在第一条，否则用户会直接 pnpm dev 然后撞
// 一堆 module not found。
export function reportSuccess(directory: string, files: readonly string[]): void {
  // 命令按用户实际用的包管理器渲染：他敲的是 `npm create reforce`，这里却教他 pnpm，
  // 那这三行就是错的。
  const packageManager = detectPackageManager();
  note(renderFileTree(files), `${directory}/ · ${files.length} 个文件`);
  note(
    [cdCommand(directory), installCommand(packageManager), runCommand(packageManager, "dev")].join(
      "\n",
    ),
    "下一步",
  );
  outro(pc.green("生成完成。"));
}

export function reportFailure(message: string): void {
  log.error(message);
}
