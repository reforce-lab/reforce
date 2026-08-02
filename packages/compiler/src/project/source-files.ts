import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type {
  CanonicalFileId,
  CompilerFrontend,
  FrontendResult,
  FrontendSourceKind,
  SourceUnit,
} from "@reforce/compiler-spi";
import type { LRUCache } from "lru-cache";
import { compareUtf16CodeUnits, sortNativePaths } from "#internal/determinism";
import { diagnostic } from "#internal/diagnostics";
import type { CachedParse } from "#internal/incremental/parse-cache";
import { isPathContained, toPortablePath } from "#internal/project/path-identity";
import {
  type PortableSourceIdentity,
  registerPortableSourceIdentity,
} from "#internal/project/source-identity";
import type {
  CompilerDiagnostic,
  CompilerWatchInputs,
  ProjectState,
  ResolvedApplicationProject,
} from "#internal/types";

export interface ParsedSource {
  readonly absolutePath: string;
  readonly fileId: CanonicalFileId;
  readonly sourceKind: FrontendSourceKind;
  readonly sourceText: string;
  readonly unit: SourceUnit;
}

export interface ParseProjectSuccess {
  readonly status: "success";
  readonly sources: readonly ParsedSource[];
  readonly watchInputs: CompilerWatchInputs;
}

export interface ParseProjectFailure {
  readonly status: "failure";
  readonly diagnostics: readonly [CompilerDiagnostic, ...CompilerDiagnostic[]];
  readonly watchInputs: CompilerWatchInputs;
}

export type ParseProjectResult = ParseProjectSuccess | ParseProjectFailure;

export function frontendSourceKind(file: string): FrontendSourceKind | undefined {
  if (file.endsWith(".d.mts")) {
    return "d.mts";
  }
  if (file.endsWith(".d.cts")) {
    return "d.cts";
  }
  if (file.endsWith(".d.ts")) {
    return "d.ts";
  }
  if (file.endsWith(".tsx")) {
    return "tsx";
  }
  if (file.endsWith(".mts")) {
    return "mts";
  }
  if (file.endsWith(".cts")) {
    return "cts";
  }
  return file.endsWith(".ts") ? "ts" : undefined;
}

function canonicalFileId(value: string): CanonicalFileId {
  return value as CanonicalFileId; // The opaque brand records the validation performed by source discovery.
}

function mergeWatchInputs(
  base: CompilerWatchInputs,
  files: readonly string[],
): CompilerWatchInputs {
  return Object.freeze({
    fileDependencies: sortNativePaths([...base.fileDependencies, ...files]),
    contextDependencies: sortNativePaths(base.contextDependencies),
    missingDependencies: sortNativePaths(base.missingDependencies),
  });
}

interface PhysicalSourceCandidate {
  readonly status: "source";
  readonly absolutePath: string;
  readonly file: string;
}

interface IgnoredSourceCandidate {
  readonly status: "ignored";
}

interface InvalidSourceCandidate {
  readonly status: "invalid";
  readonly diagnostic: CompilerDiagnostic;
}

type SourceCandidate = PhysicalSourceCandidate | IgnoredSourceCandidate | InvalidSourceCandidate;

async function inspectSourceCandidate(
  project: ResolvedApplicationProject,
  configuredPath: string,
): Promise<SourceCandidate> {
  const portableConfigured = configuredPath.replaceAll("\\", "/");
  if (
    frontendSourceKind(configuredPath) === undefined ||
    portableConfigured.includes("/.reforce/generated/") ||
    portableConfigured.includes("/node_modules/")
  ) {
    return { status: "ignored" };
  }

  let absolutePath: string;
  try {
    absolutePath = await realpath(configuredPath);
  } catch (cause) {
    return {
      status: "invalid",
      diagnostic: diagnostic({
        code: "INVALID_PROJECT_CONFIG",
        message: `Application source cannot be read: ${configuredPath}.`,
        help: "Restore the source or remove it from the leaf tsconfig source set.",
        cause,
      }),
    };
  }
  if (!isPathContained(project.projectRoot, absolutePath)) {
    return {
      status: "invalid",
      diagnostic: diagnostic({
        code: "SOURCE_OUTSIDE_PROJECT_ROOT",
        message: `Application source resolves outside projectRoot: ${configuredPath}.`,
        help: "Consume shared code through a package export instead of adding it to the application source set.",
      }),
    };
  }

  const file = toPortablePath(path.relative(project.projectRoot, absolutePath));
  if (file === "" || file.includes("#") || file.includes("\0") || file.startsWith("/")) {
    return {
      status: "invalid",
      diagnostic: diagnostic({
        code: "INVALID_SOURCE_FILE_ID",
        message: `Source path cannot form a canonical file identity: ${configuredPath}.`,
        help: "Rename the source so its project-relative path contains neither # nor NUL.",
      }),
    };
  }
  return { status: "source", absolutePath, file };
}

interface SourceDiscovery {
  readonly physicalSources: ReadonlyMap<string, string>;
  readonly diagnostics: readonly CompilerDiagnostic[];
  readonly watchInputs: CompilerWatchInputs;
}

async function discoverPhysicalSources(
  project: ResolvedApplicationProject,
  state: ProjectState,
): Promise<SourceDiscovery> {
  const physicalSources = new Map<string, string>();
  const fileIds = new Map<string, PortableSourceIdentity>();
  const diagnostics: CompilerDiagnostic[] = [];
  for (const configuredPath of state.parsedConfig.fileNames) {
    const candidate = await inspectSourceCandidate(project, configuredPath);
    if (candidate.status === "ignored") {
      continue;
    }
    if (candidate.status === "invalid") {
      diagnostics.push(candidate.diagnostic);
      continue;
    }
    if (physicalSources.has(candidate.absolutePath)) {
      continue;
    }
    const collision = registerPortableSourceIdentity(fileIds, {
      realpath: candidate.absolutePath,
      id: candidate.file,
    });
    if (collision !== undefined) {
      diagnostics.push(
        diagnostic({
          code: "SOURCE_FILE_ID_COLLISION",
          message: `Source file identity collides portably: ${candidate.file}.`,
          related: [{ message: collision.id }, { message: candidate.file }],
          help: "Rename one source so the project-relative paths differ beyond letter case.",
        }),
      );
      continue;
    }
    physicalSources.set(candidate.absolutePath, candidate.file);
  }
  return {
    physicalSources,
    diagnostics,
    watchInputs: mergeWatchInputs(state.watchInputs, [...physicalSources.keys()]),
  };
}

function convertedFrontendDiagnostics(
  result: FrontendResult,
  frontend: CompilerFrontend,
  file: string,
): readonly [CompilerDiagnostic, ...CompilerDiagnostic[]] {
  const diagnostics: CompilerDiagnostic[] = result.diagnostics.map((item) => ({
    kind: "compiler" as const,
    code: item.code,
    severity: "error" as const,
    message: item.message,
    ...(item.sourceSpan === undefined ? {} : { sourceSpan: item.sourceSpan }),
    related: item.related,
    ...(item.help === undefined ? {} : { help: item.help }),
    ...(item.cause === undefined ? {} : { cause: item.cause }),
  }));
  diagnostics.push(
    ...(diagnostics.length === 0
      ? [
          diagnostic({
            code: "PARSER_SYNTAX_ERROR",
            message: `Frontend ${frontend.id} did not produce a complete source unit for ${file}.`,
            help: "Fix the source syntax and retry compilation.",
          }),
        ]
      : []),
  );
  return [diagnostics[0] as CompilerDiagnostic, ...diagnostics.slice(1)]; // The fallback guarantees a first diagnostic.
}

interface ParsedPhysicalSourceSuccess {
  readonly status: "success";
  readonly source?: ParsedSource;
}

interface ParsedPhysicalSourceFailure {
  readonly status: "failure";
  readonly diagnostics: readonly [CompilerDiagnostic, ...CompilerDiagnostic[]];
}

async function parsePhysicalSource(
  absolutePath: string,
  file: string,
  frontend: CompilerFrontend,
  cache: LRUCache<string, CachedParse>,
): Promise<ParsedPhysicalSourceSuccess | ParsedPhysicalSourceFailure> {
  const kind = frontendSourceKind(absolutePath);
  if (kind === undefined) {
    return { status: "success" };
  }
  const sourceText = await readFile(absolutePath, "utf8");
  const fileId = canonicalFileId(file);
  const cacheKey = JSON.stringify([
    file,
    createHash("sha256").update(sourceText, "utf8").digest("hex"),
    frontend.cacheKey,
    kind,
  ]);
  const cached = cache.get(cacheKey);
  const result =
    cached === undefined
      ? await frontend.parse({ file: fileId, sourceText, sourceKind: kind })
      : { unit: cached.unit, diagnostics: [] };
  if (result.unit === undefined || result.diagnostics.length > 0) {
    return {
      status: "failure",
      diagnostics: convertedFrontendDiagnostics(result, frontend, file),
    };
  }
  if (cached === undefined) {
    cache.set(cacheKey, { unit: result.unit });
  }
  return {
    status: "success",
    source: Object.freeze({
      absolutePath,
      fileId,
      sourceKind: kind,
      sourceText,
      unit: result.unit,
    }),
  };
}

export async function parseProjectSources(
  project: ResolvedApplicationProject,
  state: ProjectState,
  frontend: CompilerFrontend,
  cache: LRUCache<string, CachedParse>,
): Promise<ParseProjectResult> {
  const discovered = await discoverPhysicalSources(project, state);
  if (discovered.diagnostics.length > 0) {
    return {
      status: "failure",
      diagnostics: [
        discovered.diagnostics[0] as CompilerDiagnostic,
        ...discovered.diagnostics.slice(1),
      ], // Length was checked before constructing the non-empty tuple.
      watchInputs: discovered.watchInputs,
    };
  }

  const orderedSources = [...discovered.physicalSources.entries()].sort((left, right) =>
    compareUtf16CodeUnits(left[1], right[1]),
  );
  const parsed: ParsedSource[] = [];
  for (const [absolutePath, file] of orderedSources) {
    const result = await parsePhysicalSource(absolutePath, file, frontend, cache);
    if (result.status === "failure") {
      return {
        status: "failure",
        diagnostics: result.diagnostics,
        watchInputs: discovered.watchInputs,
      };
    }
    if (result.source !== undefined) {
      parsed.push(result.source);
    }
  }
  return {
    status: "success",
    sources: Object.freeze(parsed),
    watchInputs: discovered.watchInputs,
  };
}
