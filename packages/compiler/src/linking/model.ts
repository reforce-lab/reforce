import type { ClassDeclaration, InterfaceDeclaration, TypeNode } from "@/parser/source-ir";
import type { SourceSpan } from "@/parser/source-location";
import type { ParsedSource } from "@/project/source-files";

// 链接阶段的结果词汇，供 module-resolver、project-linker、analysis 和 emission 共用。
// 它必须与 project-linker 分开：module-resolver 要描述自己缓存的符号，若从 project-linker
// 取类型就会反向依赖自己的调用方。不要把这些类型搬回 project-linker (#23)。

type LinkedSymbolKind = "class" | "interface" | "context" | "namespace" | "unsupported";

export interface LinkedSymbol {
  readonly key: string;
  readonly kind: LinkedSymbolKind;
  readonly name: string;
  readonly moduleSpecifier: string;
  readonly source?: ParsedSource;
  readonly declaration?: ClassDeclaration | InterfaceDeclaration;
  readonly generic: boolean;
}

export interface LinkedType {
  readonly symbol: LinkedSymbol;
  readonly typeArguments: readonly TypeNode[];
  readonly lazy: boolean;
  readonly qualifierMember?: string;
  readonly span: SourceSpan;
}
