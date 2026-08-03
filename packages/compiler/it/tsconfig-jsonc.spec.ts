import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { createTemporaryProject, type TemporaryProject } from "@reforce/tooling-testing";
import { readRawConfig } from "@/project/tsconfig-jsonc";

const projects: TemporaryProject[] = [];

afterEach(async () => {
  await Promise.all(projects.splice(0).map((project) => project.cleanup()));
});

async function readConfigText(text: string): ReturnType<typeof readRawConfig> {
  const project = await createTemporaryProject({ "tsconfig.json": text });
  projects.push(project);
  return readRawConfig(path.join(project.projectRoot, "tsconfig.json"));
}

describe("raw tsconfig reading", () => {
  test("keeps a comma followed by a bracket inside a files entry", async () => {
    const text = JSON.stringify({ files: ["src/a,].ts", "src/b.ts"] });

    const raw = await readConfigText(text);

    expect(raw.files).toEqual(["src/a,].ts", "src/b.ts"]);
  });

  test("keeps a comma followed by a brace inside an extends value", async () => {
    const text = JSON.stringify({ extends: "./base,}.json" });

    const raw = await readConfigText(text);

    expect(raw.extendValues).toEqual(["./base,}.json"]);
  });

  test("keeps comment markers that appear inside string values", async () => {
    const text = JSON.stringify({ files: ["src/a//b.ts", "src/c/*d*/e.ts"] });

    const raw = await readConfigText(text);

    expect(raw.files).toEqual(["src/a//b.ts", "src/c/*d*/e.ts"]);
  });

  test("keeps an escaped quote and the characters that follow it", async () => {
    const text = JSON.stringify({ files: ['src/a".ts', "src/b.ts"] });

    const raw = await readConfigText(text);

    expect(raw.files).toEqual(['src/a".ts', "src/b.ts"]);
  });

  test("drops line and block comments", async () => {
    const text = '{\n  // pick one\n  "files": /* inline */ ["src/a.ts"]\n}\n';

    const raw = await readConfigText(text);

    expect(raw.files).toEqual(["src/a.ts"]);
  });

  test("accepts trailing commas after the last array item and object member", async () => {
    const text = '{\n  "files": ["src/a.ts", "src/b.ts",],\n}\n';

    const raw = await readConfigText(text);

    expect(raw.files).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("reads references without interpreting their shape", async () => {
    const text = JSON.stringify({ references: [{ path: "../base" }] });

    const raw = await readConfigText(text);

    expect(raw.references).toEqual([{ path: "../base" }]);
  });

  test("reports no extends values when the key is absent", async () => {
    const raw = await readConfigText(JSON.stringify({ files: ["src/a.ts"] }));

    expect(raw.extendValues).toEqual([]);
  });

  test("accepts an array of extends values", async () => {
    const text = JSON.stringify({ extends: ["./a.json", "./b.json"] });

    const raw = await readConfigText(text);

    expect(raw.extendValues).toEqual(["./a.json", "./b.json"]);
  });

  test("rejects an extends value that is neither a string nor an array of strings", async () => {
    const text = JSON.stringify({ extends: 42 });

    await expect(readConfigText(text)).rejects.toThrow(
      "tsconfig extends must be a string or an array of strings",
    );
  });

  test("rejects an extends array that holds a non-string entry", async () => {
    const text = JSON.stringify({ extends: ["./a.json", 7] });

    await expect(readConfigText(text)).rejects.toThrow(
      "tsconfig extends must be a string or an array of strings",
    );
  });

  test("rejects a root that is an array", async () => {
    await expect(readConfigText("[]")).rejects.toThrow("tsconfig root must be an object");
  });

  test("rejects a root that is null", async () => {
    await expect(readConfigText("null")).rejects.toThrow("tsconfig root must be an object");
  });

  test("rejects malformed JSON that comment stripping cannot rescue", async () => {
    await expect(readConfigText('{ "files": [ }')).rejects.toThrow(SyntaxError);
  });
});
