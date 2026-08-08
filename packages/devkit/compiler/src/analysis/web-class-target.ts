import { providerId } from "@/analysis/model";
import type { ProjectLinker } from "@/linking/project-linker";
import type { ClassDeclaration, EntityName } from "@/parser/source-ir";
import type { ParsedSource } from "@/project/source-files";

// 应用类引用的解析（#275 抽自 useTargetOf，#363 独立成模块）：@Use 的中间件类、错误处理器
// accepts 的错误类与 @Throws 实参三处共用同一个「这个标识符指向哪个应用类」的问题，所以它
// 落在 web 分析层的最底层——上面三层各自 import 它，它谁都不 import。
// 应用类引用的统一解析(#275 抽自 useTargetOf):@Use 的中间件类、错误处理器 accepts 的
// 错误类与 @Throws 实参共用。key 与 providerId 同构,是类身份的比对键;exportName 缺失
// 意味着 routes.ts 无法 import 该类(accepts 场景硬错,@Use 场景在名录查找时自然落空)。
export interface ApplicationClassTarget {
  readonly source: ParsedSource;
  readonly declaration: ClassDeclaration;
  readonly name: string;
  readonly key: string;
  readonly exportName?: string;
}

export function applicationClassTargetOf(
  source: ParsedSource,
  entity: EntityName,
  linker: ProjectLinker,
): ApplicationClassTarget | undefined {
  const symbol = linker.resolveEntity(source, entity);
  if (symbol?.kind !== "class" || symbol.declaration?.kind !== "class") {
    return undefined;
  }
  const declaration = symbol.declaration;
  const targetName = declaration.name;
  if (symbol.source === undefined || targetName === undefined) {
    return undefined;
  }
  return {
    source: symbol.source,
    declaration,
    name: targetName,
    key: providerId(symbol.source.fileId, targetName),
    ...(declaration.export.kind === "named" ? { exportName: declaration.export.exportedName } : {}),
  };
}
