// analysis 单元测试共用的 IR 构造器（Issue #27、#35）。
// 收录两层：所有 analysis spec 都用的文件标识不透明转换与"一个 span 占 offset..offset+1、
// 恒定落在第 0 行"这条测试约定；以及 provider spec 共用的单文件 IR 词汇（singleFileIr）。
// 符号与 linker 桩各 spec 需要的解析策略不同，仍留在各自 spec 内。
import type { EntityName, ExpressionValue, SourceFileIr, TypeNode } from "@/parser/source-ir";
import type { CanonicalFileId, SourceSpan } from "@/parser/source-location";
import type { ParsedSource } from "@/project/source-files";

export function canonicalFileId(file: string): CanonicalFileId {
  return file as CanonicalFileId; // Production analysis receives this opaque identity from source discovery.
}

export function span(file: string, offset = 0): SourceSpan {
  return {
    fileId: canonicalFileId(file),
    start: { offset, line: 0, character: offset },
    end: { offset: offset + 1, line: 0, character: offset + 1 },
  };
}

// provider spec 的所有被测声明都住在同一个文件里，于是 span 只随 offset 变化，
// 每个构造器都可以省掉 fileId 参数。返回一整套而不是逐个导出常量，是为了让 spec 一行解构后
// 保留原来的局部名字（Issue #35）。
export function singleFileIr(file: string, absolutePath: string) {
  const fileId = canonicalFileId(file);
  const spanAt = (offset = 0): SourceSpan => span(file, offset);
  const identifier = (name: string): EntityName => ({
    kind: "identifier",
    name,
    span: spanAt(),
  });
  const emptyUnit: SourceFileIr = {
    imports: [],
    exports: [],
    interfaces: [],
    namespaces: [],
    classes: [],
    beanFactories: [],
    applicationDefinitions: [],
    configFactoryCalls: [],
    unsupportedDeclarations: [],
  };
  return {
    fileId,
    emptyUnit,
    span: spanAt,
    identifier,
    source: {
      absolutePath,
      fileId,
      sourceKind: "ts",
      unit: emptyUnit,
    } satisfies ParsedSource,
    voidType: { kind: "primitive", name: "void", span: spanAt() } satisfies TypeNode,
    typeReference: (name: string, typeArguments: readonly TypeNode[] = []): TypeNode => ({
      kind: "reference",
      name: identifier(name),
      typeArguments,
      span: spanAt(),
    }),
    stringLiteral: (value: string): ExpressionValue => ({
      kind: "string-literal",
      value,
      span: spanAt(),
    }),
  };
}
