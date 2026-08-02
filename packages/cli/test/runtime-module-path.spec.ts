import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTemporaryProject, type TemporaryProject } from "@reforce/tooling-testing";
import { resolveCliSupportModule } from "@/runtime-module-path";

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

test("source execution still resolves the compiled support distribution", () => {
  const runtimePath = resolveCliSupportModule({
    supportModuleName: "dev-runtime",
    invokedEntryPath: import.meta.filename,
  });

  expect(runtimePath).toBe(fileURLToPath(new URL("../dist/dev-runtime.js", import.meta.url)));
});
