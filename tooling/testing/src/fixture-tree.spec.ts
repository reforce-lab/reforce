import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { copyFixtureTree, createTemporaryProject, readFixtureTree } from "./fixture-tree";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("fixture trees", () => {
  test("materializes nested Unicode files in deterministic order", async () => {
    const project = await createTemporaryProject({
      "空 格": { "β.ts": "export const value = 1;\n" },
      "a.ts": "export {};\n",
    });
    cleanups.push(project.cleanup);

    const entries = await readFixtureTree(project.projectRoot);

    expect(entries.map((entry) => entry.path)).toEqual(["a.ts", "空 格/β.ts"]);
    expect(new TextDecoder().decode(entries[1]?.bytes)).toBe("export const value = 1;\n");
  });

  test("copies an ordinary fixture tree without following links", async () => {
    const source = await createTemporaryProject({ src: { "main.ts": "export {};\n" } });
    const destination = await createTemporaryProject();
    cleanups.push(source.cleanup, destination.cleanup);
    const copiedRoot = join(destination.projectRoot, "copy");
    await mkdir(copiedRoot);

    await copyFixtureTree(source.projectRoot, copiedRoot);

    expect(await readFile(join(copiedRoot, "src", "main.ts"), "utf8")).toBe("export {};\n");
  });

  test("cleanup is single-flight", async () => {
    const project = await createTemporaryProject();

    const first = project.cleanup();
    const second = project.cleanup();

    expect(first).toBe(second);
    await first;
  });
});
