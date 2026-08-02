import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { sortNativePaths } from "../determinism";
import { diagnostic } from "../diagnostics";
import type {
  ProjectResolutionResult,
  ProjectState,
  ResolvedApplicationProject,
  ResolveProjectRequest,
} from "../types";
import { createResolvedApplicationProject } from "../types";
import {
  type ConfigCandidateResult,
  candidateDisplayOrder,
  inspectConfigCandidate,
} from "./config";
import { isPathContained } from "./path-identity";

export interface ResolvedProjectRecord {
  readonly project: ResolvedApplicationProject;
  readonly state: ProjectState;
}

export type RememberProject = (record: ResolvedProjectRecord) => void;

interface SelectionBoundary {
  readonly canonicalPath: string;
  readonly identityPath: string;
}

interface SelectedConfigCandidate {
  readonly canonicalPath: string;
  readonly identityPath: string;
}

function failure(
  item: ReturnType<typeof diagnostic>,
  dependencies: {
    readonly fileDependencies?: readonly string[];
    readonly contextDependencies?: readonly string[];
    readonly missingDependencies?: readonly string[];
  } = {},
): ProjectResolutionResult {
  return {
    status: "failure",
    diagnostics: [item],
    watchInputs: {
      fileDependencies: sortNativePaths(dependencies.fileDependencies ?? []),
      contextDependencies: sortNativePaths(dependencies.contextDependencies ?? []),
      missingDependencies: sortNativePaths(dependencies.missingDependencies ?? []),
    },
  };
}

function automaticConfigPattern(boundary: string): string {
  return path.join(boundary, "tsconfig*.json");
}

async function resolveSelectionBoundary(directory: string): Promise<SelectionBoundary | undefined> {
  if (!path.isAbsolute(directory)) {
    return undefined;
  }
  try {
    const canonical = await realpath(directory);
    const metadata = await stat(canonical);
    return metadata.isDirectory()
      ? { canonicalPath: canonical, identityPath: directory }
      : undefined;
  } catch {
    return undefined;
  }
}

async function selectCandidates(
  boundary: string,
  tsconfigPath: string | undefined,
): Promise<
  | { readonly status: "success"; readonly candidates: readonly SelectedConfigCandidate[] }
  | { readonly status: "failure"; readonly result: ProjectResolutionResult }
> {
  if (tsconfigPath !== undefined) {
    const requested = path.isAbsolute(tsconfigPath)
      ? tsconfigPath
      : path.resolve(boundary, tsconfigPath);
    let canonical: string;
    try {
      canonical = await realpath(requested);
    } catch (cause) {
      return {
        status: "failure",
        result: failure(
          diagnostic({
            code: "INVALID_PROJECT_CONFIG",
            message: `Unable to read application config ${requested}.`,
            help: "Pass an existing leaf application tsconfig within --project.",
            cause,
          }),
          { missingDependencies: [requested] },
        ),
      };
    }
    if (!isPathContained(boundary, canonical)) {
      return {
        status: "failure",
        result: failure(
          diagnostic({
            code: "PROJECT_SELECTION_OUTSIDE_BOUNDARY",
            message: `Selected tsconfig resolves outside project boundary: ${requested}.`,
            help: "Choose a tsconfig inside the directory passed with --project.",
          }),
          { fileDependencies: [canonical] },
        ),
      };
    }
    return {
      status: "success",
      candidates: Object.freeze([{ canonicalPath: canonical, identityPath: requested }]),
    };
  }

  const entries = await readdir(boundary, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isFile() && /^tsconfig.*\.json$/u.test(entry.name))
    .map((entry) => path.join(boundary, entry.name));
  return {
    status: "success",
    candidates: candidateDisplayOrder(candidates).map((candidate) => ({
      canonicalPath: candidate,
      identityPath: candidate,
    })),
  };
}

function ambiguousSelectionFailure(
  boundary: string,
  candidates: readonly string[],
): ProjectResolutionResult {
  return {
    status: "failure",
    diagnostics: [
      diagnostic({
        code: "UNSUPPORTED_PROJECT_CONFIG",
        message: `Multiple leaf application tsconfigs exist directly in ${boundary}.`,
        related: candidateDisplayOrder(candidates).map((candidate) => ({
          message: candidate,
        })),
        help: "Pass --tsconfig to select one application config.",
      }),
    ],
    watchInputs: {
      fileDependencies: sortNativePaths(candidates),
      contextDependencies: Object.freeze([boundary]),
      missingDependencies: Object.freeze([]),
    },
  };
}

function automaticSelectionFailure(
  boundary: string,
  candidates: readonly string[],
  inspected: readonly ConfigCandidateResult[],
): ProjectResolutionResult {
  const actionableFailure = inspected.find(
    (item) =>
      item.status === "failure" &&
      item.diagnostics.some(
        (itemDiagnostic) => itemDiagnostic.code !== "UNSUPPORTED_PROJECT_CONFIG",
      ),
  );
  if (actionableFailure?.status === "failure") {
    return {
      status: "failure",
      diagnostics: [
        actionableFailure.diagnostics[0] ??
          diagnostic({
            code: "INVALID_PROJECT_CONFIG",
            message: "Application tsconfig is invalid.",
          }),
      ],
      watchInputs: actionableFailure.watchInputs,
    };
  }
  return failure(
    diagnostic({
      code: "PROJECT_CONFIG_NOT_FOUND",
      message: `No valid leaf application tsconfig exists directly in ${boundary}.`,
      help: "Add application sources to a direct leaf config or pass --tsconfig for a nested application.",
    }),
    {
      fileDependencies: candidates,
      contextDependencies: [boundary],
      missingDependencies: [automaticConfigPattern(boundary)],
    },
  );
}

function explicitSelectionFailure(
  candidates: readonly string[],
  inspected: readonly ConfigCandidateResult[],
): ProjectResolutionResult {
  const explicitFailure = inspected.at(0);
  const firstDiagnostic =
    explicitFailure?.status === "failure" ? explicitFailure.diagnostics.at(0) : undefined;
  if (explicitFailure?.status === "failure" && firstDiagnostic !== undefined) {
    return {
      status: "failure",
      diagnostics: [firstDiagnostic],
      watchInputs: explicitFailure.watchInputs,
    };
  }
  return failure(
    diagnostic({
      code: "UNSUPPORTED_PROJECT_CONFIG",
      message: "The selected tsconfig is not a supported leaf application config.",
    }),
    { fileDependencies: candidates },
  );
}

export async function resolveProject(
  request: ResolveProjectRequest,
  remember: RememberProject,
): Promise<ProjectResolutionResult> {
  const resolvedBoundary = await resolveSelectionBoundary(request.projectDirectory);
  if (resolvedBoundary === undefined) {
    return failure(
      diagnostic({
        code: "INVALID_PROJECT_DIRECTORY",
        message: `Project directory must be an existing absolute directory: ${request.projectDirectory}.`,
        help: "Resolve --project against the invocation directory before calling the Compiler.",
      }),
    );
  }
  const boundary = resolvedBoundary.canonicalPath;

  const selection = await selectCandidates(boundary, request.tsconfigPath);
  if (selection.status === "failure") {
    return selection.result;
  }
  if (selection.candidates.length === 0) {
    return failure(
      diagnostic({
        code: "PROJECT_CONFIG_NOT_FOUND",
        message: `No leaf application tsconfig exists directly in ${boundary}.`,
        help: "Add a leaf tsconfig or pass --tsconfig for a nested application.",
      }),
      {
        contextDependencies: [boundary],
        missingDependencies: [automaticConfigPattern(boundary)],
      },
    );
  }
  const candidatePaths = selection.candidates.map((candidate) => candidate.canonicalPath);

  const inspected = await Promise.all(
    selection.candidates.map((candidate) =>
      inspectConfigCandidate(boundary, candidate.canonicalPath, {
        selectionBoundary: resolvedBoundary.identityPath,
        config: candidate.identityPath,
      }),
    ),
  );
  const valid = inspected.filter((item) => item.status === "success");
  if (request.tsconfigPath === undefined && valid.length > 1) {
    return ambiguousSelectionFailure(
      boundary,
      valid.map((item) => item.tsconfigPath),
    );
  }

  const selected = valid.at(0);
  if (selected === undefined) {
    return request.tsconfigPath === undefined
      ? automaticSelectionFailure(boundary, candidatePaths, inspected)
      : explicitSelectionFailure(candidatePaths, inspected);
  }

  const project = createResolvedApplicationProject({
    projectRoot: selected.projectRoot,
    tsconfigPath: selected.tsconfigPath,
    selectionBoundary: boundary,
  });
  remember({ project, state: selected.state });
  return {
    status: "success",
    project,
    diagnostics: [],
    watchInputs: selected.state.watchInputs,
  };
}
