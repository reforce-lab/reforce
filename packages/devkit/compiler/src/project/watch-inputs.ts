import type { CompilerWatchInputs } from "@/api";
import { sortNativePaths } from "@/determinism";

interface WatchInputCollections {
  readonly fileDependencies?: Iterable<string>;
  readonly contextDependencies?: Iterable<string>;
  readonly missingDependencies?: Iterable<string>;
}

export function createWatchInputs(collections: WatchInputCollections = {}): CompilerWatchInputs {
  return Object.freeze({
    fileDependencies: sortNativePaths(collections.fileDependencies ?? []),
    contextDependencies: sortNativePaths(collections.contextDependencies ?? []),
    missingDependencies: sortNativePaths(collections.missingDependencies ?? []),
  });
}

export function mergeWatchInputs(...inputs: readonly CompilerWatchInputs[]): CompilerWatchInputs {
  return createWatchInputs({
    fileDependencies: inputs.flatMap((input) => input.fileDependencies),
    contextDependencies: inputs.flatMap((input) => input.contextDependencies),
    missingDependencies: inputs.flatMap((input) => input.missingDependencies),
  });
}
