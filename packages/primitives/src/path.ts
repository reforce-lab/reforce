import { sep } from "node:path";

// 写进生成物的路径必须是 POSIX 形式：manifest 与 import specifier 会参与 hash，Windows 上产出
// 反斜杠会让同一份源码在不同平台得到不同的 hash。
//
// separator 可注入，这样非 Windows runner 也能覆盖 Windows 语义（与 compiler
// isPathContained 的 PathSemantics 注入同一思路）；缺省即当前平台，调用方无需感知。
export function toPortablePath(nativePath: string, separator: string = sep): string {
  return nativePath.split(separator).join("/");
}
