import { defineLibraryConfig } from "@reforce/tooling-rslib";

// 不是 starter：本包不注册 bean，编译器合成的 logger bean 只借用它的 generated-runtime
// 导出（RFC 0011 L2，#242）。所以没有 reforceStarterRsbuild，也没有包级 turbo.json。
export default defineLibraryConfig();
