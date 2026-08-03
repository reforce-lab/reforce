import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { LRUCache } from "lru-cache";
import { parseSource } from "@/parser/parse-source";
import type { ClassDeclaration, InterfaceDeclaration, SourceFileIr } from "@/parser/source-ir";
import { sourceKindOf } from "@/parser/source-kind";
import type { CanonicalFileId } from "@/parser/source-location";

export interface ExternalDeclaration {
  readonly kind: "class" | "interface";
  readonly generic: boolean;
}

interface ExternalDeclarationCandidate extends ExternalDeclaration {
  readonly identity: string;
}

function addCandidate(
  candidates: Map<string, Map<string, ExternalDeclarationCandidate>>,
  exportedName: string,
  candidate: ExternalDeclarationCandidate,
): void {
  const byIdentity =
    candidates.get(exportedName) ?? new Map<string, ExternalDeclarationCandidate>();
  const existing = byIdentity.get(candidate.identity);
  byIdentity.set(candidate.identity, {
    identity: candidate.identity,
    kind: candidate.kind,
    generic: existing?.generic === true || candidate.generic,
  });
  candidates.set(exportedName, byIdentity);
}

function declarationExportName(
  declaration: ClassDeclaration | InterfaceDeclaration,
): string | undefined {
  if (declaration.export.kind === "named") {
    return declaration.export.exportedName;
  }
  return declaration.export.kind === "default-only" ? "default" : undefined;
}

function collectDeclarations(
  unit: SourceFileIr,
  candidates: Map<string, Map<string, ExternalDeclarationCandidate>>,
): ReadonlyMap<string, ExternalDeclarationCandidate> {
  const locals = new Map<string, ExternalDeclarationCandidate>();
  for (const declaration of [...unit.interfaces, ...unit.classes]) {
    const name = declaration.name;
    const generic = declaration.generic;
    const identity =
      name === undefined
        ? `${declaration.kind}:${declaration.span.start.offset}`
        : `${declaration.kind}:${name}`;
    const candidate = { identity, kind: declaration.kind, generic };
    if (name !== undefined) {
      const existing = locals.get(name);
      locals.set(name, {
        identity,
        kind: declaration.kind,
        generic: existing?.generic === true || generic,
      });
    }
    const exportedName = declarationExportName(declaration);
    if (exportedName !== undefined) {
      addCandidate(candidates, exportedName, candidate);
    }
  }
  return locals;
}

function localExportCandidates(
  declaration: SourceFileIr["exports"][number],
  locals: ReadonlyMap<string, ExternalDeclarationCandidate>,
): readonly (readonly [string, ExternalDeclarationCandidate])[] {
  if (declaration.kind === "local-named") {
    return declaration.specifiers.flatMap((specifier) => {
      const local = locals.get(specifier.local);
      return local === undefined ? [] : [[specifier.exported, local] as const];
    });
  }
  if (declaration.kind !== "default-local") {
    return [];
  }
  const local = locals.get(declaration.local);
  return local === undefined ? [] : [["default", local] as const];
}

function directExports(unit: SourceFileIr): ReadonlyMap<string, ExternalDeclaration> {
  const candidates = new Map<string, Map<string, ExternalDeclarationCandidate>>();
  const locals = collectDeclarations(unit, candidates);
  for (const declaration of unit.exports) {
    for (const [exportedName, candidate] of localExportCandidates(declaration, locals)) {
      addCandidate(candidates, exportedName, candidate);
    }
  }
  return new Map(
    [...candidates].flatMap(([exportedName, byIdentity]) => {
      const candidate = byIdentity.size === 1 ? [...byIdentity.values()][0] : undefined;
      return candidate === undefined
        ? []
        : [[exportedName, { kind: candidate.kind, generic: candidate.generic }] as const];
    }),
  );
}

function parserFileId(physicalPath: string): CanonicalFileId {
  const digest = createHash("sha256").update(physicalPath, "utf8").digest("hex");
  return `external/${digest}.ts` as CanonicalFileId; // The fixed prefix and hex digest satisfy the canonical relative path grammar.
}

export async function readExternalDeclarations(
  physicalPath: string,
  cache: LRUCache<string, SourceFileIr>,
): Promise<ReadonlyMap<string, ExternalDeclaration> | undefined> {
  const sourceKind = sourceKindOf(physicalPath);
  if (sourceKind === undefined) {
    return undefined;
  }
  let sourceText: string;
  try {
    sourceText = await readFile(physicalPath, "utf8");
  } catch {
    return undefined;
  }
  const fileId = parserFileId(physicalPath);
  const sourceHash = createHash("sha256").update(sourceText, "utf8").digest("hex");
  const cacheKey = JSON.stringify([fileId, sourceKind, sourceHash]);
  const cached = cache.get(cacheKey);
  if (cached !== undefined) {
    return directExports(cached);
  }
  const parsed = parseSource({ file: fileId, sourceKind, sourceText });
  if (parsed.status === "failure") {
    return undefined;
  }
  cache.set(cacheKey, parsed.unit);
  return directExports(parsed.unit);
}
