import path, { sep } from "node:path";

// 注入点：非 Windows runner 也要能覆盖 Windows 与 UNC 的路径语义，所以判定只依赖这三个成员，
// 由调用方决定用哪套；缺省即当前平台，调用方无需感知。
export type PathSemantics = Pick<typeof path, "isAbsolute" | "relative" | "sep">;

// 写进生成物的路径必须是 POSIX 形式：manifest 与 import specifier 会参与 hash，Windows 上产出
// 反斜杠会让同一份源码在不同平台得到不同的 hash。
//
// separator 可注入的理由与 PathSemantics 相同；这里只需要分隔符一个成员，收进 PathSemantics 会让
// 调用点被迫构造用不上的对象。
export function toPortablePath(nativePath: string, separator: string = sep): string {
  return nativePath.split(separator).join("/");
}

// 「target 是否落在 boundary 内」在本仓库有两种极性，必须是两个函数，不能合并成带 flag 的一个
// （Issue #55）：
//
// - 含自身：boundary 自身算在内，用于「这条路径归谁管」这类归属判断。
// - 严格：boundary 自身算越界，用于删除前的边界校验——lease 与 directory transaction 校验通过后
//   紧接着就是 rm(target, { recursive: true })。若 `.reforce` 是指向项目根的 symlink，realpath 后
//   target 与 boundary 相等，含自身极性会放行并递归删掉用户项目根。
//
// 调用点选错极性不产生类型错误，所以名字必须自己说清极性。
export function isPathContained(
  boundary: string,
  target: string,
  semantics: PathSemantics = path,
): boolean {
  const pathFromBoundary = semantics.relative(boundary, target);
  return pathFromBoundary === "" || isDescendantRelativePath(pathFromBoundary, semantics);
}

export function isPathStrictlyContained(
  boundary: string,
  target: string,
  semantics: PathSemantics = path,
): boolean {
  const pathFromBoundary = semantics.relative(boundary, target);
  return pathFromBoundary !== "" && isDescendantRelativePath(pathFromBoundary, semantics);
}

// relative() 对「不同盘符 / 不同 UNC share」返回的是绝对路径而不是 `..` 链，所以 isAbsolute 这条
// 不是冗余检查，它是跨盘符情形唯一的拦截点。
function isDescendantRelativePath(pathFromBoundary: string, semantics: PathSemantics): boolean {
  return (
    !semantics.isAbsolute(pathFromBoundary) &&
    pathFromBoundary !== ".." &&
    !pathFromBoundary.startsWith(`..${semantics.sep}`)
  );
}
