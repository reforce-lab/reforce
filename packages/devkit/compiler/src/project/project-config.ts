import { realpath } from "node:fs/promises";
import path from "node:path";
import { isPathContained, toPortablePath } from "@reforce/primitives";
import { parseTsconfig, type TsConfigJsonResolved } from "get-tsconfig";
import type { CompilerDiagnostic, CompilerWatchInputs } from "@/api";
import { diagnostic } from "@/diagnostics";
import {
  declarationSuffixPattern,
  discoverConfiguredFiles,
  sourceSuffixPattern,
} from "@/project/config-file-discovery";
import { type ConfigGraphObservation, collectConfigGraph } from "@/project/config-graph";
import { generatedOutputIsIncluded } from "@/project/config-pattern-coverage";
import { generatedDeclarationsFile, generatedDirectoryFragment } from "@/project/generated-paths";
import { createProjectSnapshot, type ProjectSnapshotEntry } from "@/project/project-snapshot";
import type { RawConfig } from "@/project/tsconfig-jsonc";
import { createWatchInputs } from "@/project/watch-inputs";

interface EffectiveProjectConfig {
  readonly config: TsConfigJsonResolved;
  readonly fileNames: readonly string[];
}

export interface ProjectState {
  readonly parsedConfig: EffectiveProjectConfig;
  readonly snapshot: readonly ProjectSnapshotEntry[];
  readonly watchInputs: CompilerWatchInputs;
}

interface LoadedConfig {
  readonly parsed: EffectiveProjectConfig;
  readonly configPaths: readonly string[];
  readonly rawLeaf: RawConfig;
}

interface ConfigCandidateSuccess {
  readonly status: "success";
  readonly projectRoot: string;
  readonly tsconfigPath: string;
  readonly state: ProjectState;
}

interface ConfigCandidateFailure {
  readonly status: "failure";
  readonly diagnostics: readonly CompilerDiagnostic[];
  readonly watchInputs: CompilerWatchInputs;
}

export type ConfigCandidateResult = ConfigCandidateSuccess | ConfigCandidateFailure;

interface ConfigCandidateIdentityPaths {
  readonly selectionBoundary: string;
  readonly config: string;
}

interface LoadedConfigCandidate {
  readonly status: "success";
  readonly canonicalConfig: string;
  readonly loaded: LoadedConfig;
}

async function loadConfig(
  configPath: string,
  observation: ConfigGraphObservation,
): Promise<LoadedConfig> {
  const canonicalConfig = await realpath(configPath);
  const rawLeaf = await collectConfigGraph(canonicalConfig, new Set<string>(), observation);
  const config = parseTsconfig(canonicalConfig);
  const projectRoot = path.dirname(canonicalConfig);
  const fileNames = await discoverConfiguredFiles(config, projectRoot);
  return {
    parsed: Object.freeze({ config, fileNames }),
    configPaths: observation.configPaths,
    rawLeaf,
  };
}

function isApplicationSource(file: string): boolean {
  const portable = toPortablePath(file);
  return (
    sourceSuffixPattern.test(portable) &&
    !declarationSuffixPattern.test(portable) &&
    !portable.includes(generatedDirectoryFragment) &&
    !portable.includes("/node_modules/")
  );
}

function failedConfigLoadWatchInputs(
  canonicalConfig: string | undefined,
  observation: ConfigGraphObservation,
): CompilerWatchInputs {
  const projectRoot = canonicalConfig === undefined ? undefined : path.dirname(canonicalConfig);
  const observedConfigs =
    observation.configPaths.length === 0 && canonicalConfig !== undefined
      ? [canonicalConfig]
      : observation.configPaths;
  return createWatchInputs({
    fileDependencies: observedConfigs,
    contextDependencies: projectRoot === undefined ? [] : [projectRoot],
    missingDependencies: observation.missingPaths,
  });
}

async function loadConfigCandidate(
  candidate: string,
): Promise<LoadedConfigCandidate | ConfigCandidateFailure> {
  let canonicalConfig: string | undefined;
  const observation: ConfigGraphObservation = {
    configPaths: [],
    missingPaths: [],
  };
  try {
    canonicalConfig = await realpath(candidate);
    return {
      status: "success",
      canonicalConfig,
      loaded: await loadConfig(canonicalConfig, observation),
    };
  } catch (cause) {
    return {
      status: "failure",
      diagnostics: [
        diagnostic({
          code: "INVALID_PROJECT_CONFIG",
          message: `Unable to read application config ${candidate}.`,
          help: "Fix the tsconfig JSON, its extends chain, and all referenced paths.",
          cause,
        }),
      ],
      watchInputs: failedConfigLoadWatchInputs(canonicalConfig, observation),
    };
  }
}

async function validateApplicationSources(
  loaded: LoadedConfig,
  projectRoot: string,
  applicationSources: readonly string[],
): Promise<ConfigCandidateFailure | undefined> {
  const watchInputs = createWatchInputs({
    fileDependencies: [...loaded.configPaths, ...applicationSources],
    contextDependencies: [projectRoot],
  });
  for (const source of applicationSources) {
    let canonicalSource: string;
    try {
      canonicalSource = await realpath(source);
    } catch (cause) {
      return {
        status: "failure",
        diagnostics: [
          diagnostic({
            code: "INVALID_PROJECT_CONFIG",
            message: `Application source cannot be read: ${source}.`,
            help: "Restore the source or remove it from the leaf tsconfig source set.",
            cause,
          }),
        ],
        watchInputs,
      };
    }
    if (!isPathContained(projectRoot, canonicalSource)) {
      return {
        status: "failure",
        diagnostics: [
          diagnostic({
            code: "SOURCE_OUTSIDE_PROJECT_ROOT",
            message: `Application source resolves outside projectRoot: ${source}.`,
            help: "Move the source inside the leaf application directory or consume it through a package export.",
          }),
        ],
        watchInputs,
      };
    }
  }
  return undefined;
}

// requireGeneratedDeclarations：应用项目必须把 .reforce/generated 产物纳入 tsconfig；库模式
// （ADR 0004 决策 1，#147）不产生成目录，跳过该闸门，其余项目校验两种模式共用。
export async function inspectProjectConfigCandidate(
  candidate: string,
  identityPaths: ConfigCandidateIdentityPaths,
  requireGeneratedDeclarations = true,
): Promise<ConfigCandidateResult> {
  const loadedCandidate = await loadConfigCandidate(candidate);
  if (loadedCandidate.status === "failure") {
    return loadedCandidate;
  }
  const { canonicalConfig, loaded } = loadedCandidate;

  const projectRoot = await realpath(path.dirname(canonicalConfig));
  const applicationSources = loaded.parsed.fileNames.filter(isApplicationSource);
  const failureWatchInputs = (missingDependencies: readonly string[] = []) =>
    createWatchInputs({
      fileDependencies: loaded.configPaths,
      contextDependencies: [projectRoot],
      missingDependencies,
    });
  const solutionOnly =
    Array.isArray(loaded.rawLeaf.files) &&
    loaded.rawLeaf.files.length === 0 &&
    Array.isArray(loaded.rawLeaf.references) &&
    loaded.rawLeaf.references.length > 0;
  if (solutionOnly || applicationSources.length === 0) {
    return {
      status: "failure",
      diagnostics: [
        diagnostic({
          code: "UNSUPPORTED_PROJECT_CONFIG",
          message: `${canonicalConfig} is not a leaf application tsconfig.`,
          help: "Select a leaf application tsconfig that includes application source files.",
        }),
      ],
      watchInputs: failureWatchInputs(),
    };
  }

  const moduleResolution = loaded.parsed.config.compilerOptions?.moduleResolution;
  if (moduleResolution !== "bundler" && moduleResolution !== "nodenext") {
    return {
      status: "failure",
      diagnostics: [
        diagnostic({
          code: "UNSUPPORTED_MODULE_RESOLUTION",
          message: "Application moduleResolution must be bundler or nodenext.",
          help: "Set compilerOptions.moduleResolution to Bundler or NodeNext.",
        }),
      ],
      watchInputs: failureWatchInputs(),
    };
  }

  if (
    requireGeneratedDeclarations &&
    !generatedOutputIsIncluded(loaded.parsed.config, canonicalConfig)
  ) {
    return {
      status: "failure",
      diagnostics: [
        diagnostic({
          code: "GENERATED_DECLARATIONS_NOT_INCLUDED",
          message: "The application tsconfig does not include the .reforce/generated output.",
          help: "Add .reforce/generated/**/*.ts to the leaf tsconfig include set.",
        }),
      ],
      watchInputs: failureWatchInputs([generatedDeclarationsFile(projectRoot)]),
    };
  }

  const sourceFailure = await validateApplicationSources(loaded, projectRoot, applicationSources);
  if (sourceFailure !== undefined) {
    return sourceFailure;
  }

  const snapshot = await createProjectSnapshot(
    identityPaths,
    projectRoot,
    canonicalConfig,
    loaded.configPaths,
  );
  const watchInputs = createWatchInputs({
    fileDependencies: [...loaded.configPaths, ...loaded.parsed.fileNames],
    contextDependencies: [projectRoot],
    missingDependencies: [generatedDeclarationsFile(projectRoot)],
  });
  return {
    status: "success",
    projectRoot,
    tsconfigPath: canonicalConfig,
    state: Object.freeze({
      parsedConfig: loaded.parsed,
      snapshot,
      watchInputs,
    }),
  };
}
