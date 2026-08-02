import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { parseTsconfig, type TsConfigJsonResolved } from "get-tsconfig";
import { isObject } from "radashi";
import { glob } from "tinyglobby";
import { compareUtf16CodeUnits, sortNativePaths } from "#internal/determinism";
import { diagnostic } from "#internal/diagnostics";
import { isPathContained, toPortablePath } from "#internal/project/path-identity";
import type {
  CompilerDiagnostic,
  CompilerWatchInputs,
  EffectiveProjectConfig,
  ProjectSnapshotEntry,
  ProjectState,
} from "#internal/types";

const sourceSuffixPattern = /\.(?:ts|tsx|mts|cts)$/u;
const declarationSuffixPattern = /\.d\.(?:ts|mts|cts)$/u;

interface LoadedConfig {
  readonly parsed: EffectiveProjectConfig;
  readonly configPaths: readonly string[];
  readonly rawLeaf: RawConfig;
}

interface ConfigGraphObservation {
  readonly configPaths: string[];
  readonly missingPaths: string[];
}

interface RawConfig {
  readonly extendValues: readonly string[];
  readonly files: unknown;
  readonly references: unknown;
}

export interface ConfigCandidateSuccess {
  readonly status: "success";
  readonly projectRoot: string;
  readonly tsconfigPath: string;
  readonly state: ProjectState;
}

export interface ConfigCandidateFailure {
  readonly status: "failure";
  readonly diagnostics: readonly CompilerDiagnostic[];
  readonly watchInputs: CompilerWatchInputs;
}

export type ConfigCandidateResult = ConfigCandidateSuccess | ConfigCandidateFailure;

export interface ConfigCandidateIdentityPaths {
  readonly selectionBoundary: string;
  readonly config: string;
}

interface LoadedConfigCandidate {
  readonly status: "success";
  readonly canonicalConfig: string;
  readonly loaded: LoadedConfig;
}

interface JsonTextSlice {
  readonly text: string;
  readonly nextIndex: number;
}

function quotedJsonText(text: string, start: number): JsonTextSlice {
  const quote = text[start];
  let output = quote ?? "";
  let index = start + 1;
  while (index < text.length) {
    const current = text[index] ?? "";
    output += current;
    if (current === "\\") {
      output += text[index + 1] ?? "";
      index += 2;
      continue;
    }
    index += 1;
    if (current === quote) {
      break;
    }
  }
  return { text: output, nextIndex: index };
}

function afterLineComment(text: string, start: number): number {
  let index = start + 2;
  while (index < text.length && !["\r", "\n", "\u2028", "\u2029"].includes(text[index] ?? "")) {
    index += 1;
  }
  return index;
}

function afterBlockComment(text: string, start: number): number {
  let index = start + 2;
  while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
    index += 1;
  }
  return index + 2;
}

function stripJsonComments(text: string): string {
  let output = "";
  let index = 0;
  while (index < text.length) {
    const current = text[index] ?? "";
    const next = text[index + 1];
    if (current === '"' || current === "'") {
      const quoted = quotedJsonText(text, index);
      output += quoted.text;
      index = quoted.nextIndex;
      continue;
    }
    if (current === "/" && next === "/") {
      index = afterLineComment(text, index);
      continue;
    }
    if (current === "/" && next === "*") {
      index = afterBlockComment(text, index);
      continue;
    }
    output += current;
    index += 1;
  }
  return output.replace(/,\s*([}\]])/gu, "$1");
}

function configExtendValues(value: unknown): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value;
  }
  throw new Error("tsconfig extends must be a string or an array of strings");
}

async function readRawConfig(configPath: string): Promise<RawConfig> {
  const parsed: unknown = JSON.parse(stripJsonComments(await readFile(configPath, "utf8")));
  if (!isObject(parsed)) {
    throw new Error("tsconfig root must be an object");
  }
  return {
    extendValues: configExtendValues(Reflect.get(parsed, "extends")),
    files: Reflect.get(parsed, "files"),
    references: Reflect.get(parsed, "references"),
  };
}

async function resolveExtendedConfig(
  value: string,
  containingDirectory: string,
): Promise<{ readonly path?: string; readonly missingPaths: readonly string[] }> {
  const relativeCandidate = path.resolve(containingDirectory, value);
  const candidates =
    value.startsWith(".") || path.isAbsolute(value)
      ? [
          relativeCandidate,
          `${relativeCandidate}.json`,
          path.join(relativeCandidate, "tsconfig.json"),
        ]
      : [];
  for (const candidate of candidates) {
    try {
      return { path: await realpath(candidate), missingPaths: [] };
    } catch {}
  }
  try {
    const requireFromConfig = createRequire(path.join(containingDirectory, "package.json"));
    return { path: await realpath(requireFromConfig.resolve(value)), missingPaths: [] };
  } catch {
    return { missingPaths: candidates };
  }
}

async function collectConfigGraph(
  configPath: string,
  visited: Set<string>,
  observation: ConfigGraphObservation,
): Promise<RawConfig> {
  const canonicalPath = await realpath(configPath);
  if (visited.has(canonicalPath)) {
    return { extendValues: [], files: undefined, references: undefined };
  }
  visited.add(canonicalPath);
  observation.configPaths.push(canonicalPath);
  const raw = await readRawConfig(canonicalPath);
  for (const extendValue of raw.extendValues) {
    const resolved = await resolveExtendedConfig(extendValue, path.dirname(canonicalPath));
    if (resolved.path === undefined) {
      observation.missingPaths.push(...resolved.missingPaths);
      throw new Error(`Cannot resolve extended tsconfig ${extendValue}`);
    }
    await collectConfigGraph(resolved.path, visited, observation);
  }
  return raw;
}

function normalizePatterns(patterns: readonly string[] | undefined): readonly string[] {
  return patterns?.map((pattern) => pattern.replaceAll("\\", "/")) ?? [];
}

async function discoverConfiguredFiles(
  config: TsConfigJsonResolved,
  projectRoot: string,
): Promise<readonly string[]> {
  const explicitFiles = normalizePatterns(config.files);
  const includePatterns = normalizePatterns(config.include);
  const excludePatterns = normalizePatterns(config.exclude);
  const fromFiles = explicitFiles.map((file) => path.resolve(projectRoot, file));
  const patterns =
    config.include === undefined && config.files === undefined ? ["**/*"] : includePatterns;
  const fromIncludes =
    patterns.length === 0
      ? []
      : await glob(patterns, {
          cwd: projectRoot,
          absolute: true,
          dot: true,
          onlyFiles: true,
          followSymbolicLinks: true,
          ignore: [
            "**/node_modules/**",
            "**/bower_components/**",
            "**/jspm_packages/**",
            ...excludePatterns,
          ],
        });
  return sortNativePaths([...fromFiles, ...fromIncludes]).filter((file) =>
    sourceSuffixPattern.test(toPortablePath(file)),
  );
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
    !portable.includes("/.reforce/generated/") &&
    !portable.includes("/node_modules/")
  );
}

function normalizedConfigPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "");
}

function globExpression(pattern: string): RegExp {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] ?? "";
    if (character === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index += 1;
      }
      continue;
    }
    if (character === "*") {
      expression += "[^/]*";
      continue;
    }
    if (character === "?") {
      expression += "[^/]";
      continue;
    }
    expression += /[\\^$.*+?()[\]{}|]/u.test(character) ? `\\${character}` : character;
  }
  return new RegExp(`${expression}$`, "u");
}

function patternCoversPath(pattern: string, target: string): boolean {
  const normalized = normalizedConfigPath(pattern);
  if (normalized === "." || normalized.length === 0) {
    return true;
  }
  if (!normalized.includes("*") && !normalized.includes("?")) {
    return target === normalized || target.startsWith(`${normalized}/`);
  }
  return globExpression(normalized).test(target);
}

function generatedDeclarationsAreIncluded(config: TsConfigJsonResolved): boolean {
  const generatedDeclaration = ".reforce/generated/qualifiers.d.ts";
  const excludes = normalizePatterns(config.exclude);
  if (excludes.some((pattern) => patternCoversPath(pattern, generatedDeclaration))) {
    return false;
  }
  const includes = normalizePatterns(config.include);
  const files = normalizePatterns(config.files);
  if (files.some((file) => normalizedConfigPath(file) === generatedDeclaration)) {
    return true;
  }
  if (config.include !== undefined) {
    return includes.some((pattern) => patternCoversPath(pattern, generatedDeclaration));
  }
  return config.files === undefined;
}

async function snapshotFile(file: string): Promise<ProjectSnapshotEntry> {
  const canonicalPath = await realpath(file);
  const [metadata, bytes] = await Promise.all([
    stat(canonicalPath, { bigint: true }),
    readFile(canonicalPath),
  ]);
  return Object.freeze({
    path: file,
    realpath: canonicalPath,
    dev: metadata.dev,
    ino: metadata.ino,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

async function snapshotDirectory(directory: string): Promise<ProjectSnapshotEntry> {
  const canonicalPath = await realpath(directory);
  const metadata = await stat(canonicalPath, { bigint: true });
  return Object.freeze({
    path: directory,
    realpath: canonicalPath,
    dev: metadata.dev,
    ino: metadata.ino,
  });
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
  return {
    fileDependencies: sortNativePaths(observedConfigs),
    contextDependencies:
      projectRoot === undefined ? Object.freeze([]) : Object.freeze([projectRoot]),
    missingDependencies: sortNativePaths(observation.missingPaths),
  };
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
  const watchInputs: CompilerWatchInputs = {
    fileDependencies: sortNativePaths([...loaded.configPaths, ...applicationSources]),
    contextDependencies: Object.freeze([projectRoot]),
    missingDependencies: Object.freeze([]),
  };
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

export async function inspectConfigCandidate(
  selectionBoundary: string,
  candidate: string,
  identityPaths: ConfigCandidateIdentityPaths = {
    selectionBoundary,
    config: candidate,
  },
): Promise<ConfigCandidateResult> {
  const loadedCandidate = await loadConfigCandidate(candidate);
  if (loadedCandidate.status === "failure") {
    return loadedCandidate;
  }
  const { canonicalConfig, loaded } = loadedCandidate;

  const projectRoot = await realpath(path.dirname(canonicalConfig));
  const applicationSources = loaded.parsed.fileNames.filter(isApplicationSource);
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
      watchInputs: {
        fileDependencies: sortNativePaths(loaded.configPaths),
        contextDependencies: Object.freeze([projectRoot]),
        missingDependencies: Object.freeze([]),
      },
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
      watchInputs: {
        fileDependencies: sortNativePaths(loaded.configPaths),
        contextDependencies: Object.freeze([projectRoot]),
        missingDependencies: Object.freeze([]),
      },
    };
  }

  if (!generatedDeclarationsAreIncluded(loaded.parsed.config)) {
    return {
      status: "failure",
      diagnostics: [
        diagnostic({
          code: "GENERATED_DECLARATIONS_NOT_INCLUDED",
          message: "The application tsconfig does not include .reforce/generated declarations.",
          help: "Add .reforce/generated/**/*.d.ts to the leaf tsconfig include set.",
        }),
      ],
      watchInputs: {
        fileDependencies: sortNativePaths(loaded.configPaths),
        contextDependencies: Object.freeze([projectRoot]),
        missingDependencies: Object.freeze([
          path.join(projectRoot, ".reforce", "generated", "qualifiers.d.ts"),
        ]),
      },
    };
  }

  const sourceFailure = await validateApplicationSources(loaded, projectRoot, applicationSources);
  if (sourceFailure !== undefined) {
    return sourceFailure;
  }

  const snapshot = await Promise.all([
    snapshotDirectory(identityPaths.selectionBoundary),
    ...(identityPaths.selectionBoundary === projectRoot ? [] : [snapshotDirectory(projectRoot)]),
    ...(identityPaths.config === canonicalConfig ? [] : [snapshotFile(identityPaths.config)]),
    ...loaded.configPaths.map(snapshotFile),
  ]);
  const watchInputs: CompilerWatchInputs = Object.freeze({
    fileDependencies: sortNativePaths([...loaded.configPaths, ...loaded.parsed.fileNames]),
    contextDependencies: Object.freeze([projectRoot]),
    missingDependencies: Object.freeze([
      path.join(projectRoot, ".reforce", "generated", "qualifiers.d.ts"),
    ]),
  });
  return {
    status: "success",
    projectRoot,
    tsconfigPath: canonicalConfig,
    state: Object.freeze({
      parsedConfig: loaded.parsed,
      snapshot: Object.freeze(snapshot),
      watchInputs,
    }),
  };
}

export async function snapshotStillMatches(
  entries: readonly ProjectSnapshotEntry[],
): Promise<boolean> {
  for (const expected of entries) {
    let actual: ProjectSnapshotEntry;
    try {
      actual =
        expected.sha256 === undefined
          ? await snapshotDirectory(expected.path)
          : await snapshotFile(expected.path);
    } catch {
      return false;
    }
    if (
      actual.realpath !== expected.realpath ||
      actual.dev !== expected.dev ||
      actual.ino !== expected.ino ||
      actual.sha256 !== expected.sha256
    ) {
      return false;
    }
  }
  return true;
}

export function candidateDisplayOrder(candidates: readonly string[]): readonly string[] {
  return Object.freeze([...candidates].sort(compareUtf16CodeUnits));
}
