import { compareUtf16CodeUnits } from "@reforce/primitives";
import { name as isIdentifierName } from "estree-util-is-identifier-name";
import {
  type PendingDependency,
  type ProviderDraft,
  type ProviderModel,
  providerId,
  type QualifierModel,
  sourceReference,
} from "@/analysis/model";
import type { CompilerDiagnostic } from "@/api";
import { diagnostic } from "@/diagnostics";
import type { NamespaceExportedMember } from "@/parser/source-ir";
import type { SourceSpan } from "@/parser/source-location";

type DiagnosticRelatedInformation = CompilerDiagnostic["related"][number];

const strictModuleReservedNames = new Set([
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

function validQualifierName(name: string): boolean {
  return isIdentifierName(name) && !strictModuleReservedNames.has(name);
}

function validateBeanIdentities(
  drafts: readonly ProviderDraft[],
  diagnostics: CompilerDiagnostic[],
): void {
  const byPortableId = new Map<string, ProviderModel>();
  for (const draft of drafts) {
    const key = draft.provider.id.toLowerCase();
    const collision = byPortableId.get(key);
    if (collision === undefined) {
      byPortableId.set(key, draft.provider);
      continue;
    }
    diagnostics.push(
      diagnostic({
        code: "BEAN_ID_COLLISION",
        message: `Bean identity collides portably: ${draft.provider.id}.`,
        sourceSpan: providerSourceSpan(draft.provider),
        related: [{ message: collision.id }, { message: draft.provider.id }],
        help: "Rename one direct export or source so Bean IDs differ beyond letter case.",
      }),
    );
  }
}

function indexProviderCandidates(
  drafts: readonly ProviderDraft[],
): ReadonlyMap<string, ProviderModel[]> {
  const candidates = new Map<string, ProviderModel[]>();
  for (const draft of drafts) {
    for (const provided of draft.provider.provides) {
      const existing = candidates.get(provided.key) ?? [];
      existing.push(draft.provider);
      candidates.set(provided.key, existing);
    }
  }
  return candidates;
}

function providerSourceSpan(provider: ProviderModel): SourceSpan {
  return {
    fileId: provider.source.fileId,
    start: provider.declarationSource.start,
    end: provider.declarationSource.end,
  };
}

function providerIdentityRelated(provider: ProviderModel): DiagnosticRelatedInformation {
  return { message: provider.id, sourceSpan: providerSourceSpan(provider) };
}

function qualifierAvailabilityRelated(
  drafts: readonly ProviderDraft[],
  interfaceKey: string,
  member?: string,
): readonly DiagnosticRelatedInformation[] {
  return drafts.flatMap((draft) =>
    draft.provider.qualifiers
      .filter(
        (qualifier) =>
          qualifier.interfaceSymbol.key === interfaceKey &&
          (member === undefined || qualifier.member === member) &&
          validQualifierName(qualifier.member),
      )
      .map((qualifier) => ({
        message: `${qualifier.member} -> ${draft.provider.id} (Primary: ${draft.provider.primary})`,
        sourceSpan: providerSourceSpan(draft.provider),
      })),
  );
}

function qualifierIndexKey(symbolKey: string, member: string): string {
  return `${symbolKey}\0${member}`;
}

function indexQualifiers(
  drafts: readonly ProviderDraft[],
  diagnostics: CompilerDiagnostic[],
): ReadonlyMap<string, ProviderModel> {
  const qualifierIndex = new Map<string, ProviderModel>();
  const reportedNamespaceCollisions = new Set<string>();
  for (const draft of drafts) {
    for (const qualifier of draft.provider.qualifiers) {
      if (!validQualifierName(qualifier.member)) {
        diagnostics.push(
          diagnostic({
            code: "INVALID_BEAN_QUALIFIER",
            message: `${qualifier.member} is not a valid non-reserved TypeScript identifier.`,
            help: "Choose a valid identifier for the qualifier member.",
          }),
        );
        continue;
      }
      const key = qualifierIndexKey(qualifier.interfaceSymbol.key, qualifier.member);
      const namespaceMember = qualifierNamespaceMember(qualifier);
      if (namespaceMember !== undefined && !reportedNamespaceCollisions.has(key)) {
        reportedNamespaceCollisions.add(key);
        diagnostics.push(
          diagnostic({
            code: "DUPLICATE_BEAN_QUALIFIER",
            message: `${qualifier.interfaceSymbol.name}.${qualifier.member} already exists in the source namespace.`,
            sourceSpan: namespaceMember.span,
            related: qualifierAvailabilityRelated(
              drafts,
              qualifier.interfaceSymbol.key,
              qualifier.member,
            ),
            help: "Rename the source namespace member or choose another Bean qualifier.",
          }),
        );
      }
      const collision = qualifierIndex.get(key);
      if (collision === undefined) {
        qualifierIndex.set(key, draft.provider);
        continue;
      }
      diagnostics.push(
        diagnostic({
          code: "DUPLICATE_BEAN_QUALIFIER",
          message: `${qualifier.interfaceSymbol.name}.${qualifier.member} is provided by multiple Beans.`,
          related: qualifierAvailabilityRelated(
            drafts,
            qualifier.interfaceSymbol.key,
            qualifier.member,
          ),
          help: "Assign distinct qualifier names within the interface.",
        }),
      );
    }
  }
  return qualifierIndex;
}

function qualifierNamespaceMember(qualifier: QualifierModel): NamespaceExportedMember | undefined {
  const source = qualifier.interfaceSymbol.source;
  if (source === undefined) {
    return undefined;
  }
  return source.unit.namespaces
    .filter(
      (namespace) =>
        namespace.topLevel &&
        namespace.export.kind === "named" &&
        namespace.name === qualifier.interfaceSymbol.name,
    )
    .flatMap((namespace) => namespace.exportedMembers)
    .find((member) => member.name === qualifier.member);
}

function validatePrimaryCandidates(
  candidates: ReadonlyMap<string, ProviderModel[]>,
  diagnostics: CompilerDiagnostic[],
): void {
  for (const [symbolKey, providers] of candidates) {
    const primary = providers.filter((provider) => provider.primary);
    if (primary.length <= 1) {
      continue;
    }
    diagnostics.push(
      diagnostic({
        code: "MULTIPLE_PRIMARY_BEANS",
        message: `Multiple Primary Beans provide ${symbolKey}.`,
        related: primary
          .toSorted((left, right) => compareUtf16CodeUnits(left.id, right.id))
          .map(providerIdentityRelated),
        help: "Keep at most one Primary provider for each interface.",
      }),
    );
  }
}

function qualifiedDependencyProvider(
  pending: PendingDependency,
  qualifierIndex: ReadonlyMap<string, ProviderModel>,
  drafts: readonly ProviderDraft[],
  diagnostics: CompilerDiagnostic[],
): ProviderModel | undefined {
  const qualifierMember = pending.linkedType.qualifierMember;
  if (qualifierMember === undefined) {
    return undefined;
  }
  const selected = qualifierIndex.get(
    qualifierIndexKey(pending.linkedType.symbol.key, qualifierMember),
  );
  if (selected !== undefined) {
    return selected;
  }
  diagnostics.push(
    diagnostic({
      code: "UNKNOWN_BEAN_QUALIFIER",
      message: `Unknown qualifier ${pending.linkedType.symbol.name}.${qualifierMember}.`,
      sourceSpan: pending.linkedType.span,
      related: qualifierAvailabilityRelated(drafts, pending.linkedType.symbol.key),
      help: "Use one of the generated qualifier members for this interface.",
    }),
  );
  return undefined;
}

function unqualifiedDependencyProvider(
  pending: PendingDependency,
  candidates: ReadonlyMap<string, ProviderModel[]>,
  diagnostics: CompilerDiagnostic[],
): ProviderModel | undefined {
  const available = candidates.get(pending.linkedType.symbol.key) ?? [];
  if (pending.linkedType.symbol.kind === "class") {
    const source = pending.linkedType.symbol.source;
    const ownId =
      source === undefined ? undefined : providerId(source.fileId, pending.linkedType.symbol.name);
    const ownProvider = available.find(
      (provider) => provider.kind === "class" && provider.id === ownId,
    );
    if (ownProvider !== undefined) {
      return ownProvider;
    }
    if (available.length === 0) {
      diagnostics.push(
        diagnostic({
          code: "MISSING_BEAN",
          message: `No Injectable Bean provides ${pending.linkedType.symbol.name}.`,
          sourceSpan: pending.linkedType.span,
          help: "Mark the concrete class Injectable or inject an application interface.",
        }),
      );
      return undefined;
    }
  }
  if (available.length === 1) {
    return available[0];
  }
  if (available.length === 0) {
    diagnostics.push(
      diagnostic({
        code: "MISSING_BEAN",
        message: `No Bean provides ${pending.linkedType.symbol.name}.`,
        sourceSpan: pending.linkedType.span,
        help: "Declare a local Injectable wrapper or defineBean provider in this application.",
      }),
    );
    return undefined;
  }
  const primary = available.filter((provider) => provider.primary);
  if (primary.length === 1) {
    return primary[0];
  }
  if (primary.length === 0) {
    diagnostics.push(
      diagnostic({
        code: "AMBIGUOUS_BEAN",
        message: `Multiple Beans provide ${pending.linkedType.symbol.name}.`,
        sourceSpan: pending.linkedType.span,
        related: available.map(providerIdentityRelated),
        help: "Mark one provider Primary or inject a generated qualifier.",
      }),
    );
  }
  return undefined;
}

function dependencyProvider(
  pending: PendingDependency,
  drafts: readonly ProviderDraft[],
  candidates: ReadonlyMap<string, ProviderModel[]>,
  qualifierIndex: ReadonlyMap<string, ProviderModel>,
  diagnostics: CompilerDiagnostic[],
): ProviderModel | undefined {
  return pending.linkedType.qualifierMember === undefined
    ? unqualifiedDependencyProvider(pending, candidates, diagnostics)
    : qualifiedDependencyProvider(pending, qualifierIndex, drafts, diagnostics);
}

function resolveProviderDependencies(
  drafts: readonly ProviderDraft[],
  candidates: ReadonlyMap<string, ProviderModel[]>,
  qualifierIndex: ReadonlyMap<string, ProviderModel>,
  diagnostics: CompilerDiagnostic[],
): void {
  for (const draft of drafts) {
    for (const pending of draft.pendingDependencies) {
      const selected = dependencyProvider(pending, drafts, candidates, qualifierIndex, diagnostics);
      if (selected === undefined) {
        continue;
      }
      draft.provider.dependencies.push({
        parameterIndex: pending.index,
        targetId: selected.id,
        mode: pending.linkedType.lazy ? "explicit-lazy" : "eager",
        source: sourceReference(pending.sourceSpan),
      });
    }
  }
}

export function resolveProviders(
  drafts: readonly ProviderDraft[],
  diagnostics: CompilerDiagnostic[],
): void {
  validateBeanIdentities(drafts, diagnostics);
  const candidates = indexProviderCandidates(drafts);
  const qualifierIndex = indexQualifiers(drafts, diagnostics);
  validatePrimaryCandidates(candidates, diagnostics);
  resolveProviderDependencies(drafts, candidates, qualifierIndex, diagnostics);
}
