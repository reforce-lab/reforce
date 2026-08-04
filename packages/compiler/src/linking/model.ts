import type { ClassDeclaration, InterfaceDeclaration, TypeNode } from "@/parser/source-ir";
import type { SourceSpan } from "@/parser/source-location";
import type { ParsedSource } from "@/project/source-files";

// 链接阶段的结果词汇，供 module-resolver、project-linker、analysis 和 emission 共用。
// 它必须与 project-linker 分开：module-resolver 要描述自己缓存的符号，若从 project-linker
// 取类型就会反向依赖自己的调用方。不要把这些类型搬回 project-linker (#23)。

type LinkedSymbolKind = "class" | "interface" | "context" | "config" | "namespace" | "unsupported";

// 外部符号的包视角坐标（ADR 0004 决策 7，#120）：key 以包根为锚，两份物理拷贝天然两个身份
// （决策 10 不合并）；coordinate 是诊断与 manifest 用的展示形；metaSubpath 来自 meta 户口表，
// 是 type-only import 的首选 specifier。
export interface ExternalSymbolAttribution {
  readonly packageName: string;
  readonly version: string;
  readonly packageRoot: string;
  readonly coordinate: string;
  readonly metaSubpath?: string;
}

export interface LinkedSymbol {
  readonly key: string;
  readonly kind: LinkedSymbolKind;
  readonly name: string;
  readonly moduleSpecifier: string;
  readonly source?: ParsedSource;
  readonly declaration?: ClassDeclaration | InterfaceDeclaration;
  readonly generic: boolean;
  readonly external?: ExternalSymbolAttribution;
}

export interface LinkedType {
  readonly symbol: LinkedSymbol;
  readonly typeArguments: readonly TypeNode[];
  readonly lazy: boolean;
  // Current<T> 句柄（ADR 0006 W7，#142 / #151）：singleton 跨 scope 访问请求态的唯一通道，
  // 与 lazy 同为包装标记，二者互斥（嵌套包装在分析层点名拒绝）。
  readonly current: boolean;
  readonly qualifierMember?: string;
  readonly span: SourceSpan;
}
