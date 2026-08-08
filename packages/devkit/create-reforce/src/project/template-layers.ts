import type { ProjectSpec } from "@/project/package-json";

// 模板按目录叠加，后写的覆盖先写的。三个引擎的差异只有 src/application.ts 与
// src/config/web-server.config.ts 两个文件，所以 engine-<key>/ 里也只有这两个——不复制整棵
// base。lint 层同理，只有一个 biome.jsonc。加引擎或加可选特性都是加一个目录，不动这里的逻辑。
export function templateLayersFor(spec: ProjectSpec): readonly string[] {
  return ["base", `engine-${spec.engine}`, ...(spec.lint ? ["lint"] : [])];
}
