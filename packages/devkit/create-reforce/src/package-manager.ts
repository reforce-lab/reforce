export const PACKAGE_MANAGERS = ["pnpm", "npm", "yarn", "bun", "deno"] as const;

export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

const DEFAULT_PACKAGE_MANAGER: PackageManager = "pnpm";

function isPackageManager(value: string): value is PackageManager {
  return (PACKAGE_MANAGERS as readonly string[]).includes(value);
}

/**
 * 从 npm_config_user_agent 认出用户实际用的包管理器。
 *
 * 这个变量由包管理器自己在执行 `create-*` 时注入，形如
 * `pnpm/11.20.0 npm/? node/v26.5.1 linux x64`，取第一段的名字即可。
 * 不认识或没有这个变量时退回 pnpm——本仓库的文档一律用 pnpm 举例。
 *
 * 这件事的价值全在收尾提示上：用户敲的是 `npm create reforce`，提示却教他 `pnpm install`，
 * 那这条提示就是错的。
 */
export function detectPackageManager(
  userAgent: string | undefined = process.env.npm_config_user_agent,
): PackageManager {
  const name = userAgent?.split(" ")[0]?.split("/")[0];
  return name !== undefined && isPackageManager(name) ? name : DEFAULT_PACKAGE_MANAGER;
}

// yarn 装依赖不带子命令（`yarn` 即安装），其余都是 `<pm> install`。
export function installCommand(packageManager: PackageManager): string {
  return packageManager === "yarn" ? "yarn" : `${packageManager} install`;
}

// npm 必须走 `npm run <script>`，deno 用 `deno task <script>`，其余直接 `<pm> <script>`。
export function runCommand(packageManager: PackageManager, script: string): string {
  if (packageManager === "npm") {
    return `npm run ${script}`;
  }
  if (packageManager === "deno") {
    return `deno task ${script}`;
  }
  return `${packageManager} ${script}`;
}

// 含空格的路径直接贴进终端会被拆成两个参数，加引号才是可以照抄的命令。
export function cdCommand(directory: string): string {
  return directory.includes(" ") ? `cd "${directory}"` : `cd ${directory}`;
}
