import { cp, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { temporaryDirectory } from "tempy";

export type FixtureTree = {
  readonly [name: string]: FixtureTree | string | Uint8Array;
};

export interface FixtureTreeEntry {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface TemporaryProject {
  readonly projectRoot: string;
  cleanup(): Promise<void>;
}

function compareUtf16CodeUnits(left: string, right: string): number {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) {
      return difference;
    }
  }
  return left.length - right.length;
}

function assertContained(root: string, target: string): void {
  const pathFromRoot = relative(root, target);
  if (
    pathFromRoot === "" ||
    (!isAbsolute(pathFromRoot) && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`))
  ) {
    return;
  }
  throw new Error(`Fixture path escapes its root: ${target}`);
}

async function materializeFixtureDirectory(root: string, tree: FixtureTree): Promise<void> {
  const names = Object.keys(tree).sort(compareUtf16CodeUnits);
  for (const name of names) {
    const value = tree[name];
    if (
      value === undefined ||
      name.length === 0 ||
      name === "." ||
      name === ".." ||
      name.includes("/") ||
      name.includes("\\")
    ) {
      throw new Error(`Invalid fixture entry name: ${name}`);
    }

    const target = resolve(root, name);
    assertContained(root, target);
    if (typeof value === "string" || value instanceof Uint8Array) {
      await writeFile(target, value);
      continue;
    }

    await mkdir(target);
    await materializeFixtureDirectory(target, value);
  }
}

export async function writeFixtureTree(root: string, tree: FixtureTree): Promise<void> {
  const canonicalRoot = await realpath(root);
  await materializeFixtureDirectory(canonicalRoot, tree);
}

export async function createTemporaryProject(tree: FixtureTree = {}): Promise<TemporaryProject> {
  const projectRoot = temporaryDirectory({ prefix: "reforce-" });
  await writeFixtureTree(projectRoot, tree);

  let cleanupPromise: Promise<void> | undefined;
  return {
    projectRoot,
    cleanup() {
      cleanupPromise ??= rm(projectRoot, { force: true, recursive: true });
      return cleanupPromise;
    },
  };
}

export async function copyFixtureTree(source: string, destination: string): Promise<void> {
  const canonicalSource = await realpath(source);
  await mkdir(destination, { recursive: true });
  const canonicalDestination = await realpath(destination);
  if (canonicalSource === canonicalDestination) {
    throw new Error("Fixture source and destination must differ");
  }
  const entries = await readdir(canonicalSource, { withFileTypes: true });
  entries.sort((left, right) => compareUtf16CodeUnits(left.name, right.name));
  for (const entry of entries) {
    const sourceEntry = resolve(canonicalSource, entry.name);
    const destinationEntry = resolve(canonicalDestination, entry.name);
    assertContained(canonicalSource, sourceEntry);
    assertContained(canonicalDestination, destinationEntry);
    await cp(sourceEntry, destinationEntry, {
      dereference: false,
      errorOnExist: true,
      force: false,
      recursive: true,
    });
  }
}

async function collectFixtureEntries(
  root: string,
  directory: string,
  entries: FixtureTreeEntry[],
): Promise<void> {
  const directoryEntries = await readdir(directory, { withFileTypes: true });
  directoryEntries.sort((left, right) => compareUtf16CodeUnits(left.name, right.name));
  for (const entry of directoryEntries) {
    const absolutePath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await collectFixtureEntries(root, absolutePath, entries);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Fixture trees only support ordinary files and directories: ${absolutePath}`);
    }
    entries.push({
      path: relative(root, absolutePath).split(sep).join("/"),
      bytes: await readFile(absolutePath),
    });
  }
}

export async function readFixtureTree(root: string): Promise<readonly FixtureTreeEntry[]> {
  const canonicalRoot = await realpath(root);
  const entries: FixtureTreeEntry[] = [];
  await collectFixtureEntries(canonicalRoot, canonicalRoot, entries);
  return entries;
}
