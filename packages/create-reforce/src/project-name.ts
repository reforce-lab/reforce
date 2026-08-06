import { basename, resolve } from "node:path";

// npm 包名的核心规则（长度另算）：可选 scope + 小写起首字母数字，其余允许 - . _ ~。
// 这里不引 validate-npm-package-name——生成物只需要判定「这个名字能不能写进 package.json」，
// 一条正则就是全部判据，多一个依赖换不来别的信息。
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const MAX_PACKAGE_NAME_LENGTH = 214;

// 目录名只是包名的**默认值**，不是包名本身：`~/Projects/My App` 是完全合法的目录，
// 只有写进 package.json 的那个名字需要守 npm 的规则。两者在这里分开。
//
// 相对路径相对 cwd 解析，不用裸 resolve()——那会落到进程当前目录上，`.` 这类输入就会
// 推出错误的名字。
export function packageNameFromDirectory(directory: string, cwd: string): string {
  return basename(resolve(cwd, directory));
}

// 返回 undefined 表示合法；返回字符串是给用户看的原因。clack 的 validate 正好吃这个形状。
export function validatePackageName(name: string): string | undefined {
  if (name.length === 0) {
    return "包名不能为空。";
  }
  if (name.length > MAX_PACKAGE_NAME_LENGTH) {
    return `包名不能超过 ${MAX_PACKAGE_NAME_LENGTH} 个字符。`;
  }
  if (name !== name.toLowerCase()) {
    return "包名必须全小写。";
  }
  if (!PACKAGE_NAME_PATTERN.test(name)) {
    return "包名只能包含小写字母、数字和 - . _ ~，且不能以 . 或 _ 开头。";
  }
  return undefined;
}

/**
 * 把任意目录名压成一个能写进 package.json 的名字，规则与 create-vite 一致：
 * 空白转连字符、去掉开头的 . 或 _、其余非法字符统一转连字符。
 *
 * 用规范化而不是报错，是因为「目录叫 My App」根本不是错误——用户没义务让目录名满足
 * npm 的命名规则。规范化结果只作为默认值，交互时还会让用户确认。
 */
export function toValidPackageName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/^[._]/, "")
    .replace(/[^a-z0-9\-~]+/g, "-");
}
