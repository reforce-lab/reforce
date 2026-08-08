// reforce-meta.json 的契约本体（#369）：类型、parser 与坐标文法。
//
// 它是**独立包**而不是 @reforce/compiler 的一个导出：写 starter 适配的人要在自己的 CI 里验
// meta，而编译器当不了那个 devDependency——它把 typescript 钉在精确 nightly 加 tsgo 原生二进制。
// 本包除 @reforce/primitives 外零依赖，装它不等于装框架。
export {
  type ParseStarterMetaOptions,
  parseContractCoordinate,
  parseStarterMeta,
  type StarterContractCoordinate,
  type StarterMeta,
  type StarterMetaBean,
  type StarterMetaCapability,
  type StarterMetaDependency,
  type StarterMetaParseResult,
  type StarterMetaSymbol,
  starterMetaCapabilities,
  starterMetaSubpath,
  supportedSchemaVersions,
} from "@/meta";
export {
  checkStarterPackage,
  findExportsProblem,
  type StarterPackageCheckInput,
  type StarterPackageProblem,
} from "@/package-check";
export { type MetaObjectShape, type MetaShapeName, metaShapes } from "@/schema-shape";
export type { SourcePositionModel, SourceReferenceModel } from "@/source-reference";
