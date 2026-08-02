import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isObject } from "radashi";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const typescriptCli = fileURLToPath(
  new URL("../../node_modules/typescript/bin/tsc", import.meta.url),
);
const executeFile = promisify(execFile);

async function packageConfigPaths(): Promise<readonly string[]> {
  const paths: string[] = [];
  for (const workspaceDirectory of ["packages", "platforms", "tooling"] as const) {
    const workspaceRoot = path.join(repositoryRoot, workspaceDirectory);
    for (const entry of await readdir(workspaceRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const packageRoot = path.join(workspaceRoot, entry.name);
      for (const filename of await readdir(packageRoot)) {
        if (/^tsconfig(?:\.[^.]+)*\.json$/u.test(filename)) {
          paths.push(path.join(packageRoot, filename));
        }
      }
    }
  }
  return paths.toSorted();
}

test("every workspace TypeScript config keeps legacy decorators disabled", async () => {
  const configPaths = await packageConfigPaths();

  const effectiveConfigs = await Promise.all(
    configPaths.map(async (configPath) => {
      const { stdout } = await executeFile(
        "node",
        [typescriptCli, "--showConfig", "--project", configPath],
        { cwd: repositoryRoot, shell: false, windowsHide: true },
      );
      const config: unknown = JSON.parse(stdout);
      const compilerOptions = isObject(config) ? Reflect.get(config, "compilerOptions") : undefined;
      if (!isObject(compilerOptions)) {
        throw new TypeError(`${configPath} did not produce compiler options.`);
      }
      return compilerOptions;
    }),
  );

  expect(configPaths.length).toBeGreaterThan(0);
  for (const compilerOptions of effectiveConfigs) {
    expect(Reflect.get(compilerOptions, "experimentalDecorators")).toBe(false);
    expect(Reflect.get(compilerOptions, "emitDecoratorMetadata")).toBe(false);
  }
});
