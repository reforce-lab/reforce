import { expect, test } from "bun:test";
import { isAbsolute } from "node:path";
import { resolveBunExecutable, runCommand } from "./index";

test("resolves an absolute executable that runs an actual Bun runtime", async () => {
  const executable = await resolveBunExecutable();

  const result = await runCommand(executable, [
    "-p",
    'JSON.stringify({bun:Reflect.get(process.versions,"bun")})',
  ]);

  expect(isAbsolute(executable)).toBe(true);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(String(result.stdout))).toEqual({ bun: process.versions.bun });
});
