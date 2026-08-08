import type { TsConfigJson } from "get-tsconfig";

// 「一份能过 resolveProject 的最小 application tsconfig」这条知识只能有一份实现（Issue #381）：
// 判据收紧时（#350 要求 `.reforce/generated` 的 .d.ts 与 .ts 两半都被收下）it/ 下散着九份私有副本，
// 只有被 skipIf 整体挡住的那份没跟上，一路拖到 Windows CI 才现形。
//
// 例外是 project-resolution.spec.ts 的 filesConfig：它存在的目的就是造**违反**判据的 tsconfig，
// 不能走这里的补全。
const generatedHalves = [".reforce/generated/qualifiers.d.ts", ".reforce/generated/beans.ts"];

export interface ApplicationTsconfigOptions {
  // 只给 include 时按原样写入，不补生成物：library 用例要的正是「不收生成物」的编译单元。
  readonly include?: readonly string[];
  // files 形式无法用通配收下生成物，只能逐条点名，所以由这里补全两半。
  readonly files?: readonly string[];
  // 浅合并到基座，覆盖 paths 与 decorator 开关这类各 spec 自己的差异。
  readonly compilerOptions?: TsConfigJson["compilerOptions"];
}

export function applicationTsconfig({
  include,
  files,
  compilerOptions,
}: ApplicationTsconfigOptions = {}): string {
  return `${JSON.stringify({
    compilerOptions: {
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      ...compilerOptions,
    },
    ...(files === undefined
      ? { include: include ?? ["src", ".reforce/generated/**/*.ts"] }
      : { files: [...files, ...generatedHalves] }),
  })}\n`;
}
