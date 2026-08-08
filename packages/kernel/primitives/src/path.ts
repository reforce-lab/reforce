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

// 拿路径当 Map key 时用这个，不要直接用原串：tsgo 返回正斜杠规范名，Node 的 path.join 在 Windows 上
// 给反斜杠，精确比对会把项目文件整批误判成「不在 program」；Windows 文件系统大小写不敏感，盘符大小写
// 也必须一并折叠。查询发往 server 时仍用 tsgo 侧的规范名，key 只用于本地比对。
//
// 两个形态各自注入，不合成一个 platform 参数：分隔符与大小写敏感性是两条独立的文件系统属性，
// 参数缺省即当前平台（Issue #381）。
export interface CanonicalPathKeyOptions {
  readonly separator?: string;
  readonly caseInsensitive?: boolean;
}

export function toCanonicalPathKey(
  nativePath: string,
  { separator = sep, caseInsensitive = process.platform === "win32" }: CanonicalPathKeyOptions = {},
): string {
  const portable = toPortablePath(nativePath, separator);
  return caseInsensitive ? portable.toLowerCase() : portable;
}

// 从磁盘读回、或由 bundler stats 报上来的相对路径，在参与 join / 写进 manifest 之前必须先过这一关。
// 拒绝的每一项都是「join 之后会跑出目标目录」或「同一份源码在不同平台得到不同 hash」的入口：绝对
// 路径与盘符前缀会让 join 直接跳到别处，反斜杠在 POSIX 上是合法文件名字符、到 Windows 上却变成分隔符，
// NUL 会被底层系统调用截断，`.` / `..` 段则是最直接的逃逸。
//
// 规则必须只有一份实现：CLI 侧的 transaction journal、stats 资产名、generated manifest 与 dev build
// id 四个信任边界用的是同一条准入规则，此前各自持有一份副本，其中 build id 那份已经漏掉了 NUL 与盘符
// 两项——副本一旦分头演化，收紧规则时就会漏掉其中几处。
export function isRelativePosixPath(value: string): boolean {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    /^[A-Za-z]:/u.test(value)
  ) {
    return false;
  }
  return value
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
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
