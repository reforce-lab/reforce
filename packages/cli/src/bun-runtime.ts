export function requireBunExecutable(): string {
  if (typeof process.versions.bun !== "string") {
    throw new Error("Reforce requires Bun.");
  }
  return process.execPath;
}
