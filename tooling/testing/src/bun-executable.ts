import { realpath } from "node:fs/promises";

let resolution: Promise<string> | undefined;

async function findBunExecutable(): Promise<string> {
  if (typeof process.versions.bun !== "string") {
    throw new Error("Reforce tooling must run in Bun.");
  }
  return await realpath(process.execPath);
}

export function resolveBunExecutable(): Promise<string> {
  resolution ??= findBunExecutable();
  return resolution;
}
