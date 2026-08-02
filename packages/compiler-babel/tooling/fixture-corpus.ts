import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CanonicalFileId, FrontendInput, FrontendSourceKind } from "@reforce/compiler-spi";
import { compareUtf16CodeUnits } from "#internal/normalize";

export const fixtureDirectory = fileURLToPath(new URL("../../compiler/fixtures", import.meta.url));

const sourceKinds: readonly string[] = ["ts", "tsx", "mts", "cts", "d.ts", "d.mts", "d.cts"];

function canonicalFileId(value: string): CanonicalFileId {
  return value as CanonicalFileId; // Compiler normally supplies the branded project-relative identity.
}

function isFrontendSourceKind(value: unknown): value is FrontendSourceKind {
  return typeof value === "string" && sourceKinds.includes(value);
}

function sourceKind(filename: string): FrontendSourceKind {
  if (filename.endsWith(".d.mts")) {
    return "d.mts";
  }
  if (filename.endsWith(".d.cts")) {
    return "d.cts";
  }
  if (filename.endsWith(".d.ts")) {
    return "d.ts";
  }
  if (filename.endsWith(".tsx")) {
    return "tsx";
  }
  if (filename.endsWith(".mts")) {
    return "mts";
  }
  if (filename.endsWith(".cts")) {
    return "cts";
  }
  return "ts";
}

function isSourceFile(filename: string): boolean {
  return /(?:\.d)?\.(?:ts|tsx|mts|cts)$/u.test(filename);
}

async function sourceFiles(directory: string, relative = ""): Promise<readonly string[]> {
  const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryRelative = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        return sourceFiles(directory, entryRelative);
      }
      return isSourceFile(entry.name) ? [entryRelative] : [];
    }),
  );
  return nested
    .flat()
    .toSorted((left, right) =>
      compareUtf16CodeUnits(left.split(path.sep).join("/"), right.split(path.sep).join("/")),
    );
}

async function encodedInput(projectDirectory: string): Promise<FrontendInput | undefined> {
  try {
    const value: unknown = JSON.parse(
      await readFile(path.join(projectDirectory, "input.json"), "utf8"),
    );
    if (
      typeof value !== "object" ||
      value === null ||
      !("file" in value) ||
      typeof value.file !== "string" ||
      !("sourceKind" in value) ||
      !isFrontendSourceKind(value.sourceKind) ||
      !("sourceText" in value) ||
      typeof value.sourceText !== "string"
    ) {
      throw new Error(`Invalid encoded frontend input in ${projectDirectory}`);
    }
    return {
      file: canonicalFileId(value.file),
      sourceKind: value.sourceKind,
      sourceText: value.sourceText,
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function fixtureNames(): Promise<readonly string[]> {
  return (await readdir(fixtureDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted(compareUtf16CodeUnits);
}

export async function frontendFixtureNames(): Promise<readonly string[]> {
  return (await fixtureNames()).filter(
    (name) => name.startsWith("frontend-") || name.startsWith("parser-"),
  );
}

export async function loadFrontendInputs(name: string): Promise<readonly FrontendInput[]> {
  const projectDirectory = path.join(fixtureDirectory, name, "project");
  const encoded = await encodedInput(projectDirectory);
  if (encoded !== undefined) {
    return [encoded];
  }
  return Promise.all(
    (await sourceFiles(projectDirectory)).map(async (filename) => ({
      file: canonicalFileId(filename.split(path.sep).join("/")),
      sourceKind: sourceKind(filename),
      sourceText: await readFile(path.join(projectDirectory, filename), "utf8"),
    })),
  );
}
