import {
  type AliasExpansion,
  type AnnotationHeadSymbol,
  leftmostIdentifier,
  type SchemaTraceScope,
  type SchemaTraceTarget,
  type SlotResolutionContext,
} from "@/analysis/web-slots";
import type { CompilerDiagnostic } from "@/api";
import type { ProjectLinker } from "@/linking/project-linker";
import type {
  ClassMethodDeclaration,
  EntityName,
  MethodParameter,
  TypeNode,
} from "@/parser/source-ir";
import type { ParsedSource } from "@/project/source-files";
import type { TypeQuery } from "@/typescript/type-query";
import type { TsSymbol, TsType } from "@/typescript/unstable-api";

// 槽位解析的生产接线(RFC 0012 S2,#274):把 linker 的符号解析与 checker 门面绑定成
// web-slots 算法的注入面。位置查询遵守 S1 性能守则——整条方法的参数名 offset 与方法名
// offset 一次批量 getTypesAtPositions,且是懒的:纯裸槽位(RequestContext/Request/Headers)
// 路由零查询,不触发 tsgo spawn。

export interface SlotContextInputs {
  readonly source: ParsedSource;
  readonly method: ClassMethodDeclaration;
  readonly linker: ProjectLinker;
  readonly query: TypeQuery | undefined;
  readonly fileIdOf: (declarationPath: string) => string | undefined;
  readonly diagnostics: CompilerDiagnostic[];
}

export function createSlotResolutionContext(
  inputs: SlotContextInputs,
): SlotResolutionContext<TsType, TsSymbol> {
  const { source, method, linker, query } = inputs;
  const scopes = new Map<ParsedSource, SchemaTraceScope<TsType>>();

  // 懒批量:首个查询触发一次取回本方法全部锚点(各参数名位 + 方法名位)。
  let answers: ReadonlyMap<number, TsType | undefined> | undefined;
  const methodNameOffset =
    method.name.kind === "identifier" ? method.name.span.start.offset : undefined;
  function answerAt(offset: number | undefined): TsType | undefined {
    if (offset === undefined || query === undefined) {
      return undefined;
    }
    if (answers === undefined) {
      const offsets = [
        ...method.parameters.flatMap((parameter) =>
          parameter.nameSpan === undefined ? [] : [parameter.nameSpan.start.offset],
        ),
        ...(methodNameOffset === undefined ? [] : [methodNameOffset]),
      ];
      const types = query.getTypesAtPositions(source.absolutePath, offsets);
      answers = new Map(offsets.map((position, index) => [position, types[index]]));
    }
    return answers.get(offset);
  }

  function declarationTypeAt(declarationSource: ParsedSource, offset: number): TsType | undefined {
    if (query === undefined) {
      return undefined;
    }
    return query.getTypesAtPositions(declarationSource.absolutePath, [offset])[0];
  }

  // schema 追溯作用域:typeof 的值标识符与嵌套别名都要在"它们出现的模块"里解析。
  function scopeFor(scopeSource: ParsedSource): SchemaTraceScope<TsType> {
    const existing = scopes.get(scopeSource);
    if (existing !== undefined) {
      return existing;
    }
    const scope: SchemaTraceScope<TsType> = {
      aliasRhsOf: (name: EntityName): AliasExpansion<TsType> | undefined => {
        const symbol = linker.resolveEntity(scopeSource, name);
        if (symbol?.kind !== "unsupported" || symbol.source === undefined) {
          return undefined;
        }
        const aliasSource = symbol.source;
        const declaration = aliasSource.unit.unsupportedDeclarations.find(
          (item) =>
            item.declarationKind === "type-alias" &&
            item.name === symbol.name &&
            item.rhs !== undefined,
        );
        if (declaration?.rhs === undefined) {
          return undefined;
        }
        return { rhs: declaration.rhs, ...scopeFor(aliasSource) };
      },
      schemaTargetOf: (name: EntityName): SchemaTraceTarget<TsType> | undefined => {
        const resolved = linker.resolveValueDeclaration(scopeSource, leftmostIdentifier(name));
        if (resolved === undefined || resolved.exportName === undefined) {
          return undefined;
        }
        // ValueDeclaration 的 span 起点就是声明标识符(lower-source),名位查询直接可用。
        return {
          ref: { source: resolved.source, exportName: resolved.exportName },
          type: declarationTypeAt(resolved.source, resolved.declaration.span.start.offset),
        };
      },
    };
    scopes.set(scopeSource, scope);
    return scope;
  }

  const rootScope = scopeFor(source);

  return {
    query,
    fileIdOf: inputs.fileIdOf,
    diagnostics: inputs.diagnostics,
    aliasRhsOf: rootScope.aliasRhsOf,
    schemaTargetOf: rootScope.schemaTargetOf,
    typeAtParameter: (parameter: MethodParameter) => answerAt(parameter.nameSpan?.start.offset),
    typeAtMethodName: () => answerAt(methodNameOffset),
    headSymbolOf: (name: EntityName): AnnotationHeadSymbol => {
      const symbol = linker.resolveEntity(source, name);
      if (symbol?.kind === "web") {
        return { kind: "web", name: symbol.name };
      }
      if (symbol === undefined && name.kind === "identifier") {
        return { kind: "global", name: name.name };
      }
      return { kind: "other" };
    },
    contractDeclarationTypeOf: (
      reference: Extract<TypeNode, { readonly kind: "reference" }>,
    ): TsType | undefined => {
      const symbol = linker.resolveEntity(source, reference.name);
      if (symbol === undefined || symbol.generic || symbol.source === undefined) {
        return undefined;
      }
      if (symbol.kind === "interface" && symbol.declaration?.kind === "interface") {
        const nameSpan = symbol.declaration.nameSpan;
        return nameSpan === undefined
          ? undefined
          : declarationTypeAt(symbol.source, nameSpan.start.offset);
      }
      if (symbol.kind === "unsupported") {
        const declaration = symbol.source.unit.unsupportedDeclarations.find(
          (item) =>
            item.declarationKind === "type-alias" && item.name === symbol.name && !item.generic,
        );
        return declaration?.nameSpan === undefined
          ? undefined
          : declarationTypeAt(symbol.source, declaration.nameSpan.start.offset);
      }
      return undefined;
    },
  };
}
