import { afterEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createTemporaryProject, type TemporaryProject } from "@reforce/tooling-testing";
import { resolveCliSupportModule } from "#internal/runtime-module-path";

let temporaryProject: TemporaryProject | undefined;

afterEach(async () => {
  await temporaryProject?.cleanup();
  temporaryProject = undefined;
});

test("a built CLI resolves a compiled support module beside its executable", async () => {
  temporaryProject = await createTemporaryProject({
    dist: {
      "reforce.js": "export {};\n",
      "production-runtime.js": "export {};\n",
    },
  });
  const entryPath = join(temporaryProject.projectRoot, "dist", "reforce.js");

  const runtimePath = resolveCliSupportModule({
    supportModuleName: "production-runtime",
    invokedEntryPath: entryPath,
  });

  expect(runtimePath).toBe(join(temporaryProject.projectRoot, "dist", "production-runtime.js"));
});

test("source execution resolves a TypeScript support module beside its caller", async () => {
  temporaryProject = await createTemporaryProject({ "entry.ts": "export {};\n" });
  const callerPath = join(temporaryProject.projectRoot, "entry.ts");
  await writeFile(join(temporaryProject.projectRoot, "dev-runtime.ts"), "export {};\n");

  const runtimePath = resolveCliSupportModule({
    supportModuleName: "dev-runtime",
    invokedEntryPath: callerPath,
  });

  expect(runtimePath).toBe(join(dirname(callerPath), "dev-runtime.ts"));
});
