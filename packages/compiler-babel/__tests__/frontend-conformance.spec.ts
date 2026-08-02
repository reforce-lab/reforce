import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FrontendDiagnostic, SourceUnit } from "@reforce/compiler-spi";
import { yukuFrontend } from "@reforce/compiler-yuku";
import { babelFrontend } from "#internal/frontend";
import {
  fixtureDirectory,
  fixtureNames,
  frontendFixtureNames,
  loadFrontendInputs,
} from "#tooling/fixture-corpus";

interface FrontendGolden {
  readonly units: readonly SourceUnit[];
  readonly diagnostics: readonly FrontendDiagnostic[];
}

async function readJson<T>(filename: string): Promise<T> {
  return JSON.parse(await readFile(filename, "utf8"));
}

async function expectedResult(
  name: string,
  usesFrontendDiagnostics: boolean,
): Promise<FrontendGolden> {
  const expectedDirectory = path.join(fixtureDirectory, name, "expected");
  let units: readonly SourceUnit[] = [];
  try {
    units = await readJson<readonly SourceUnit[]>(path.join(expectedDirectory, "source-ir.json"));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  return {
    units,
    diagnostics: usesFrontendDiagnostics
      ? await readJson<readonly FrontendDiagnostic[]>(
          path.join(expectedDirectory, "diagnostics.json"),
        )
      : [],
  };
}

async function parseCase(frontend: typeof babelFrontend, name: string): Promise<FrontendGolden> {
  const results = await Promise.all(
    (await loadFrontendInputs(name)).map((input) => frontend.parse(input)),
  );
  return {
    units: results.flatMap((result) => (result.unit === undefined ? [] : [result.unit])),
    diagnostics: results.flatMap((result) => result.diagnostics),
  };
}

describe("frontend conformance corpus", async () => {
  const frontendCases = new Set(await frontendFixtureNames());
  for (const name of await fixtureNames()) {
    test(`${name} matches both adapters and its committed golden`, async () => {
      const expected = await expectedResult(name, frontendCases.has(name));

      const [babelResult, yukuResult] = await Promise.all([
        parseCase(babelFrontend, name),
        parseCase(yukuFrontend, name),
      ]);

      expect(babelResult).toEqual(yukuResult);
      expect(babelResult).toEqual(expected);
    });
  }
});
