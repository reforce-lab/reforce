// meta 各层的键名清单（#369）：parser 与 JSON Schema 都从这里取，两侧不可能各自漂。
//
// 它还是「格式可选键 ⊆ 生成器可产出键」那条守卫测试的输入（#343 的成因正是 schema 认 8 个
// 字段而 `reforce lib` 只产 6 个，静默漂了一年）。守卫住在 compiler 的 it 里——只有那边同时
// 看得到本表与真实生成物。

export interface MetaObjectShape {
  readonly required: readonly string[];
  readonly optional: readonly string[];
}

export const metaShapes = {
  root: {
    required: ["schemaVersion", "starterDeps", "symbols", "beans"],
    optional: ["requires"],
  },
  symbol: { required: ["id", "file", "subpaths"], optional: [] },
  bean: {
    required: ["id", "runtimeExport", "provides", "dependencies"],
    optional: ["defaultBean", "role", "lifecycle", "source"],
  },
  dependency: { required: ["contract", "open"], optional: ["collection"] },
  runtimeExport: { required: ["module", "export"], optional: [] },
  lifecycle: { required: [], optional: ["start", "close"] },
  sourceReference: { required: ["file", "start", "end"], optional: [] },
  position: { required: ["offset", "line", "character"], optional: [] },
} as const satisfies Record<string, MetaObjectShape>;

export type MetaShapeName = keyof typeof metaShapes;
