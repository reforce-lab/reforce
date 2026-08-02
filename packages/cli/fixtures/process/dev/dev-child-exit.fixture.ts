const exitCode = Number(process.argv[2]);
if (!Number.isInteger(exitCode) || exitCode < 0) {
  throw new Error("Development child fixture requires a non-negative exit code.");
}

await new Promise<void>((resolve) => setTimeout(resolve, 20));
process.exitCode = exitCode;
