import { compareUtf16CodeUnits } from "@reforce/primitives";
import { dedupeSymbols, linkedClassContracts } from "@/analysis/class-provider";
import { type ProviderDraft, providerId, sourceReference } from "@/analysis/model";
import type { CompilerDiagnostic } from "@/api";
import { diagnostic } from "@/diagnostics";
import type { ProjectLinker } from "@/linking/project-linker";
import type { ClassDeclaration, ClassHeritage, EntityName } from "@/parser/source-ir";
import type { SourceSpan } from "@/parser/source-location";
import type { ParsedSource } from "@/project/source-files";

// ADR 0005（#130）决策 5：只识别 extends 位置的 ConfigProperties 直接调用；括号包裹、条件
// 表达式、中间变量一律硬错，不静默跳过（#54 教训）。识别靠 import 符号解析（允许别名），
// 与 defineBean/defineApplication 的"parser 收形状、链接层核实来源"同一策略。

// 与 @reforce/config 运行时工厂的 prefix 校验刻意重复：编译期在声明处给早期诊断，运行时
// 工厂兜住未经编译器的构造（如测试直构）。两份各自有表驱动测试锁定。
const prefixPattern = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$/;

const declarationHelp =
  'Declare export class X extends ConfigProperties("prefix", schema) {} at top level, with methods only.';

function invalidConfigProperties(
  message: string,
  span: SourceSpan | undefined,
  related: CompilerDiagnostic["related"] = [],
): CompilerDiagnostic {
  return diagnostic({
    code: "INVALID_CONFIG_PROPERTIES",
    message,
    sourceSpan: span,
    related,
    help: declarationHelp,
  });
}

export interface ConfigAnalysis {
  readonly drafts: readonly ProviderDraft[];
  readonly claimed: ReadonlySet<ClassDeclaration>;
}

function resolvesToConfigProperties(
  source: ParsedSource,
  entity: EntityName,
  linker: ProjectLinker,
): boolean {
  const symbol = linker.resolveEntity(source, entity);
  return symbol?.kind === "config" && symbol.name === "ConfigProperties";
}

function referencedNameResolvesToConfigProperties(
  source: ParsedSource,
  heritage: Extract<ClassHeritage, { readonly kind: "expression" }>,
  linker: ProjectLinker,
): boolean {
  return heritage.referencedNames.some((name) =>
    resolvesToConfigProperties(source, { kind: "identifier", name, span: heritage.span }, linker),
  );
}

type HeritageClassification =
  | {
      readonly kind: "recognized";
      readonly call: Extract<ClassHeritage, { readonly kind: "call" }>;
    }
  | { readonly kind: "misuse"; readonly span: SourceSpan }
  | { readonly kind: "unrelated" };

function classifyHeritage(
  source: ParsedSource,
  declaration: ClassDeclaration,
  linker: ProjectLinker,
): HeritageClassification {
  const heritage = declaration.heritage;
  if (heritage === undefined) {
    return { kind: "unrelated" };
  }
  if (heritage.kind === "call") {
    if (!resolvesToConfigProperties(source, heritage.callee, linker)) {
      return { kind: "unrelated" };
    }
    return heritage.parenthesized
      ? { kind: "misuse", span: heritage.span }
      : { kind: "recognized", call: heritage };
  }
  if (heritage.kind === "reference") {
    return resolvesToConfigProperties(source, heritage.entity, linker)
      ? { kind: "misuse", span: heritage.span }
      : { kind: "unrelated" };
  }
  return referencedNameResolvesToConfigProperties(source, heritage, linker)
    ? { kind: "misuse", span: heritage.span }
    : { kind: "unrelated" };
}

function reportIntermediateCalls(
  source: ParsedSource,
  linker: ProjectLinker,
  diagnostics: CompilerDiagnostic[],
): void {
  for (const call of source.unit.configFactoryCalls) {
    if (resolvesToConfigProperties(source, call.callee, linker)) {
      diagnostics.push(
        invalidConfigProperties(
          "ConfigProperties must be the direct call expression in an extends clause; an intermediate variable hides the config class from the compiler.",
          call.span,
        ),
      );
    }
  }
}

function reifiedPrefix(
  call: Extract<ClassHeritage, { readonly kind: "call" }>,
  diagnostics: CompilerDiagnostic[],
): string | undefined {
  const argument = call.arguments.at(0);
  if (argument?.kind !== "string-literal") {
    diagnostics.push(
      invalidConfigProperties(
        "ConfigProperties prefix must be a string literal: the compiler maps it to environment variable names without evaluating code.",
        argument?.span ?? call.span,
      ),
    );
    return undefined;
  }
  if (!prefixPattern.test(argument.value)) {
    diagnostics.push(
      invalidConfigProperties(
        `Config prefix ${JSON.stringify(argument.value)} must be dot-separated camelCase words starting with a lowercase letter.`,
        argument.span,
      ),
    );
    return undefined;
  }
  return argument.value;
}

function validateConfigClassShape(
  source: ParsedSource,
  declaration: ClassDeclaration,
  linker: ProjectLinker,
  diagnostics: CompilerDiagnostic[],
): boolean {
  const decorated = declaration.decorators.some((decorator) => {
    if (decorator.callee.kind === "unsupported-expression") {
      return false;
    }
    return linker.resolveEntity(source, decorator.callee)?.kind === "core";
  });
  if (decorated) {
    diagnostics.push(
      invalidConfigProperties(
        "A config class cannot combine Reforce decorators: it is bound before any Bean and needs no selection markers.",
        declaration.span,
      ),
    );
    return false;
  }
  if (
    !declaration.topLevel ||
    declaration.abstract ||
    declaration.generic ||
    declaration.name === undefined ||
    declaration.export.kind !== "named"
  ) {
    diagnostics.push(
      invalidConfigProperties(
        "A config class must be a top-level, non-abstract, non-generic direct named export.",
        declaration.span,
      ),
    );
    return false;
  }
  const declaredConstructor = declaration.constructors.at(0);
  if (declaredConstructor !== undefined) {
    diagnostics.push(
      invalidConfigProperties(
        "A config class cannot declare a constructor: the ConfigProperties base constructor is the single door for framework binding and test construction.",
        declaredConstructor.span,
      ),
    );
    return false;
  }
  const instanceField = declaration.fields.find((field) => !field.static);
  if (instanceField !== undefined) {
    diagnostics.push(
      invalidConfigProperties(
        "A config class cannot declare instance fields: field initializers would overwrite the bound values.",
        instanceField.span,
      ),
    );
    return false;
  }
  return true;
}

interface RecognizedConfig {
  readonly draft: ProviderDraft;
  readonly prefix: string;
  readonly span: SourceSpan;
  readonly fileId: string;
}

function analyzeConfigClass(
  source: ParsedSource,
  declaration: ClassDeclaration,
  call: Extract<ClassHeritage, { readonly kind: "call" }>,
  linker: ProjectLinker,
  diagnostics: CompilerDiagnostic[],
): RecognizedConfig | undefined {
  if (!validateConfigClassShape(source, declaration, linker, diagnostics)) {
    return undefined;
  }
  const prefix = reifiedPrefix(call, diagnostics);
  if (prefix === undefined) {
    return undefined;
  }
  const exportName = declaration.name;
  if (exportName === undefined) {
    return undefined;
  }
  const ownSymbol = linker.symbolForDeclaration(source, declaration);
  if (ownSymbol === undefined) {
    diagnostics.push(
      invalidConfigProperties(
        `Cannot establish class identity for ${exportName}.`,
        declaration.span,
      ),
    );
    return undefined;
  }
  const contracts = linkedClassContracts(
    source,
    declaration,
    exportName,
    ownSymbol,
    linker,
    diagnostics,
  );
  if (contracts.startHook || contracts.closeHook) {
    diagnostics.push(
      invalidConfigProperties(
        "A config class cannot declare lifecycle interfaces: it is plain bound data outside the Bean lifecycle.",
        declaration.span,
      ),
    );
    return undefined;
  }
  return {
    draft: {
      provider: {
        kind: "config",
        id: providerId(source.fileId, exportName),
        origin: { kind: "application", source },
        exportName,
        declarationSource: sourceReference(declaration.span),
        provides: dedupeSymbols(contracts.provided),
        // config 实例由启动期绑定 phase 产生、先于一切 bean 构造（ADR 0005），天然 singleton。
        scope: "singleton",
        primary: false,
        qualifiers: [],
        dependencies: [],
        prefix,
      },
      pendingDependencies: [],
    },
    prefix,
    span: declaration.span,
    fileId: source.fileId,
  };
}

function reportDuplicatePrefixes(
  recognized: readonly RecognizedConfig[],
  diagnostics: CompilerDiagnostic[],
): readonly RecognizedConfig[] {
  const firstByPrefix = new Map<string, RecognizedConfig>();
  const unique: RecognizedConfig[] = [];
  const ordered = recognized.toSorted((left, right) => {
    const file = compareUtf16CodeUnits(left.fileId, right.fileId);
    return file === 0 ? left.span.start.offset - right.span.start.offset : file;
  });
  for (const config of ordered) {
    const first = firstByPrefix.get(config.prefix);
    if (first === undefined) {
      firstByPrefix.set(config.prefix, config);
      unique.push(config);
      continue;
    }
    diagnostics.push(
      diagnostic({
        code: "DUPLICATE_CONFIG_PREFIX",
        message: `Config prefix ${JSON.stringify(config.prefix)} is already declared by ${first.draft.provider.id}.`,
        sourceSpan: config.span,
        related: [{ message: first.draft.provider.id, sourceSpan: first.span }],
        help: "Give each config class a unique prefix.",
      }),
    );
  }
  return unique;
}

export function analyzeConfigProviders(
  sources: readonly ParsedSource[],
  linker: ProjectLinker,
  diagnostics: CompilerDiagnostic[],
): ConfigAnalysis {
  const claimed = new Set<ClassDeclaration>();
  const recognized: RecognizedConfig[] = [];
  for (const source of sources) {
    if (source.sourceKind.startsWith("d.")) {
      continue;
    }
    reportIntermediateCalls(source, linker, diagnostics);
    for (const declaration of source.unit.classes) {
      const classification = classifyHeritage(source, declaration, linker);
      if (classification.kind === "unrelated") {
        continue;
      }
      claimed.add(declaration);
      if (classification.kind === "misuse") {
        diagnostics.push(
          invalidConfigProperties(
            "ConfigProperties must be the direct call expression in an extends clause: parentheses, conditionals, and other wrappers hide the config class from the compiler.",
            classification.span,
          ),
        );
        continue;
      }
      const config = analyzeConfigClass(
        source,
        declaration,
        classification.call,
        linker,
        diagnostics,
      );
      if (config !== undefined) {
        recognized.push(config);
      }
    }
  }
  const unique = reportDuplicatePrefixes(recognized, diagnostics);
  return {
    drafts: unique.map((config) => config.draft),
    claimed,
  };
}
