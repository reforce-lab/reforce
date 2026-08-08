import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";

export interface ProjectSnapshotEntry {
  readonly path: string;
  readonly realpath: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly sha256?: string;
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

export async function createProjectSnapshot(
  identityPaths: {
    readonly selectionBoundary: string;
    readonly config: string;
  },
  projectRoot: string,
  canonicalConfig: string,
  configPaths: readonly string[],
): Promise<readonly ProjectSnapshotEntry[]> {
  return Object.freeze(
    await Promise.all([
      snapshotDirectory(identityPaths.selectionBoundary),
      ...(identityPaths.selectionBoundary === projectRoot ? [] : [snapshotDirectory(projectRoot)]),
      ...(identityPaths.config === canonicalConfig ? [] : [snapshotFile(identityPaths.config)]),
      ...configPaths.map(snapshotFile),
    ]),
  );
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
