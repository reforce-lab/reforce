import { fileURLToPath } from "node:url";

// 模板目录的唯一定位点。src/templates-root.ts 和构建后的 dist/templates-root.js 都恰好在
// 包根下一层，所以 `../templates/` 在两种运行形态下解析到同一个目录：vitest 直接跑 src，
// 发布产物跑 dist。别把这个 URL 计算内联到 src/project/ 等更深的模块里——那里的相对层级
// 是 ../../，两处各写一份迟早对不上。
export const TEMPLATES_ROOT = fileURLToPath(new URL("../templates/", import.meta.url));
