import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 与 templates-root.ts 同一条约束：本模块必须留在包根下一层，`../package.json` 才在 src
// 与 dist 两种运行形态下指向同一个文件。
export function readPackageVersion(): string {
  const path = fileURLToPath(new URL("../package.json", import.meta.url));
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "version" in parsed &&
    typeof parsed.version === "string"
  ) {
    return parsed.version;
  }
  throw new Error("create-reforce 自身的 package.json 缺少 version 字段。");
}
