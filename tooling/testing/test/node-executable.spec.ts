import { isAbsolute } from "node:path";
import { expect, test } from "vitest";
import { resolveNodeExecutable, runCommand } from "@/index";

test("resolves an absolute executable running the actual Node.js runtime", async () => {
  const executable = await resolveNodeExecutable();

  const result = await runCommand(executable, [
    "-p",
    'JSON.stringify({node:Reflect.get(process.versions,"node")})',
  ]);

  expect(isAbsolute(executable)).toBe(true);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(String(result.stdout))).toEqual({ node: process.versions.node });
});
