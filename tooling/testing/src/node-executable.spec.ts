import { expect, test } from "bun:test";
import { isAbsolute } from "node:path";
import { resolveNodeExecutable, runCommand } from "#internal/index";

test("resolves an absolute executable that runs an actual Node runtime", async () => {
  const executable = await resolveNodeExecutable();

  const result = await runCommand(executable, [
    "-p",
    'JSON.stringify({release:process.release.name,bun:Reflect.get(process.versions,"bun")})',
  ]);

  expect(isAbsolute(executable)).toBe(true);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(String(result.stdout))).toEqual({ release: "node" });
});
