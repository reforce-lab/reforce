import type { LinkedSymbol } from "@/linking/model";
import type { ImportReference, ModuleRecord } from "@/linking/module-resolver";
import type { ClassDeclaration, InterfaceDeclaration } from "@/parser/source-ir";
import type { ParsedSource } from "@/project/source-files";

// ParsedSource 到 ModuleRecord 的一次性投影：把一个文件的顶层声明和 import 绑定摊成两张查名字的表。
// 这里不解析任何跨模块引用，所以它不需要 resolver、不需要 diagnostics，也不持有闭包状态（Issue #117）。

function createLocalSymbol(
  source: ParsedSource,
  declaration: ClassDeclaration | InterfaceDeclaration,
): LinkedSymbol | undefined {
  const name = declaration.name;
  if (name === undefined) {
    return undefined;
  }
  return Object.freeze({
    key: `${source.fileId}#${declaration.kind}:${name}`,
    kind: declaration.kind,
    name,
    moduleSpecifier: source.fileId,
    source,
    declaration,
    generic: declaration.generic,
  });
}

function localSymbolsFor(source: ParsedSource): ReadonlyMap<string, LinkedSymbol> {
  const localSymbols = new Map<string, LinkedSymbol>();
  for (const declaration of [...source.unit.interfaces, ...source.unit.classes]) {
    const symbol = createLocalSymbol(source, declaration);
    if (symbol !== undefined) {
      localSymbols.set(symbol.name, symbol);
    }
  }
  for (const declaration of source.unit.unsupportedDeclarations) {
    const name = declaration.name;
    if (name !== undefined) {
      localSymbols.set(
        name,
        Object.freeze({
          key: `${source.fileId}#unsupported:${name}`,
          kind: "unsupported",
          name,
          moduleSpecifier: source.fileId,
          source,
          generic: declaration.generic,
        }),
      );
    }
  }
  return localSymbols;
}

function importReferencesFor(source: ParsedSource): ReadonlyMap<string, ImportReference> {
  const imports = new Map<string, ImportReference>();
  for (const declaration of source.unit.imports) {
    if (declaration.kind !== "import") {
      continue;
    }
    for (const binding of declaration.bindings) {
      if (binding.kind === "default") {
        imports.set(binding.local, {
          moduleSpecifier: declaration.moduleSpecifier,
          imported: "default",
          namespace: false,
        });
        continue;
      }
      if (binding.kind === "namespace") {
        imports.set(binding.local, {
          moduleSpecifier: declaration.moduleSpecifier,
          imported: "*",
          namespace: true,
        });
        continue;
      }
      imports.set(binding.local, {
        moduleSpecifier: declaration.moduleSpecifier,
        imported: binding.imported,
        namespace: false,
      });
    }
  }
  return imports;
}

export function createModuleRecord(source: ParsedSource): ModuleRecord {
  return {
    source,
    localSymbols: localSymbolsFor(source),
    imports: importReferencesFor(source),
  };
}
