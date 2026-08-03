import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { compareUtf16CodeUnits, toPortablePath } from "@reforce/primitives";
import type { LRUCache } from "lru-cache";
import type { CompilerDiagnostic, CompilerWatchInputs, ResolvedApplicationProject } from "@/api";
import { diagnostic } from "@/diagnostics";
import { parseSource } from "@/parser/parse-source";
import type { SourceFileIr, SourceKind } from "@/parser/source-ir";
import { sourceKindOf } from "@/parser/source-kind";
import type { CanonicalFileId } from "@/parser/source-location";
import { generatedDirectoryFragment } from "@/project/generated-paths";
import { isPathContained } from "@/project/path-identity";
import type { ProjectState } from "@/project/project-config";
import { createWatchInputs, mergeWatchInputs } from "@/project/watch-inputs";

export interface ParsedSource {
  readonly absolutePath: string;
  readonly fileId: CanonicalFileId;
  readonly sourceKind: SourceKind;
  readonly unit: SourceFileIr;
}

interface ParseProjectSuccess {
  readonly status: "success";
  readonly sources: readonly ParsedSource[];
  readonly watchInputs: CompilerWatchInputs;
}

interface ParseProjectFailure {
  readonly status: "failure";
  readonly diagnostics: readonly [CompilerDiagnostic, ...CompilerDiagnostic[]];
  readonly watchInputs: CompilerWatchInputs;
}

type ParseProjectResult = ParseProjectSuccess | ParseProjectFailure;

function canonicalFileId(value: string): CanonicalFileId {
  return value as CanonicalFileId; // The opaque brand records the validation performed by source discovery.
}

interface PortableSourceIdentity {
  readonly realpath: string;
  readonly id: string;
}

function registerPortableSourceIdentity(
  identities: Map<string, PortableSourceIdentity>,
  candidate: PortableSourceIdentity,
): PortableSourceIdentity | undefined {
  const key = candidate.id.toLowerCase();
  const existing = identities.get(key);
  if (existing === undefined) {
    identities.set(key, candidate);
    return undefined;
  }
  return existing.realpath === candidate.realpath ? undefined : existing;
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
    sourceKindOf(configuredPath) === undefined ||
    portableConfigured.includes(generatedDirectoryFragment) ||
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
    watchInputs: mergeWatchInputs(
      state.watchInputs,
      createWatchInputs({ fileDependencies: physicalSources.keys() }),
    ),
  };
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
  cache: LRUCache<string, SourceFileIr>,
): Promise<ParsedPhysicalSourceSuccess | ParsedPhysicalSourceFailure> {
  const kind = sourceKindOf(absolutePath);
  if (kind === undefined) {
    // Only reachable when a configured path is a symlink to a differently-named non-source file:
    // discovery already accepted the configured name's suffix.
    return { status: "success" };
  }
  const sourceText = await readFile(absolutePath, "utf8");
  const fileId = canonicalFileId(file);
  const cacheKey = JSON.stringify([
    fileId,
    kind,
    createHash("sha256").update(sourceText, "utf8").digest("hex"),
  ]);
  let unit = cache.get(cacheKey);
  if (unit === undefined) {
    const result = parseSource({ file: fileId, sourceText, sourceKind: kind });
    if (result.status === "failure") {
      return {
        status: "failure",
        diagnostics: result.diagnostics,
      };
    }
    unit = result.unit;
    cache.set(cacheKey, unit);
  }
  return {
    status: "success",
    source: Object.freeze({
      absolutePath,
      fileId,
      sourceKind: kind,
      unit,
    }),
  };
}

export async function parseProjectSources(
  project: ResolvedApplicationProject,
  state: ProjectState,
  cache: LRUCache<string, SourceFileIr>,
): Promise<ParseProjectResult> {
  const discovered = await discoverPhysicalSources(project, state);
  const [firstDiagnostic, ...remainingDiagnostics] = discovered.diagnostics;
  if (firstDiagnostic !== undefined) {
    return {
      status: "failure",
      diagnostics: [firstDiagnostic, ...remainingDiagnostics],
      watchInputs: discovered.watchInputs,
    };
  }

  const orderedSources = [...discovered.physicalSources.entries()].sort((left, right) =>
    compareUtf16CodeUnits(left[1], right[1]),
  );
  const parsed: ParsedSource[] = [];
  for (const [absolutePath, file] of orderedSources) {
    const result = await parsePhysicalSource(absolutePath, file, cache);
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
