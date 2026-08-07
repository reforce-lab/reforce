#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { requireNodeExecutable } from "@reforce/runtime/node-runtime";
import { runCli } from "@/commands/run-cli";

// 版本在**入口**读，不在深处读：dist 是 bundleless 的，深层模块到包根的相对深度会随目录
// 结构漂移，而这个文件恒在 dist/ 一层下（安装后是 node_modules/@reforce/cli/dist/reforce.js）。
// 读失败一律当「不知道」——一条招牌行不值得让整个 CLI 起不来。
function cliVersion(): string | undefined {
  try {
    const raw: unknown = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    const version =
      typeof raw === "object" && raw !== null ? Reflect.get(raw, "version") : undefined;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

requireNodeExecutable();
const version = cliVersion();
const exitCode = await runCli(version === undefined ? {} : { version });
process.exitCode = exitCode;
