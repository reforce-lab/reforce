import path from "node:path";

// All knowledge of where compiler-generated output lives: every "is this the generated directory"
// check and every reference to the generated declarations derives from these constants, so
// renaming the output layout stays a single-point change.
const generatedDirectory = ".reforce/generated";
const generatedDeclarationsEntry = "qualifiers.d.ts";
const generatedModuleEntry = "beans.ts";

/** Portable project-relative path of the generated qualifiers declarations. */
export const generatedDeclarationsPath = `${generatedDirectory}/${generatedDeclarationsEntry}`;

// 生成的 .ts 也必须进用户的编译单元（#350）：emission 写出的 `new Target(...)` 实参个数、
// 织入链形状、契约 import 都是普通 TypeScript，进了类型检查这一整类生成缺陷就在编译期炸；
// 只收 .d.ts 时它们一路静默到运行期才现形。
/** Portable project-relative path of a generated module that must type-check with the app. */
export const generatedModulePath = `${generatedDirectory}/${generatedModuleEntry}`;

/** Substring that recognizes generated output inside an already-portable absolute path. */
export const generatedDirectoryFragment = `/${generatedDirectory}/`;

/** Absolute path of the directory that receives compiler-generated files. */
export function generatedDirectoryPath(projectRoot: string): string {
  return path.join(projectRoot, ...generatedDirectory.split("/"));
}

export function generatedDeclarationsFile(projectRoot: string): string {
  return path.join(projectRoot, ...generatedDirectory.split("/"), generatedDeclarationsEntry);
}
