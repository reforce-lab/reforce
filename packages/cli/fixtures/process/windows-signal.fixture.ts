import { pathToFileURL } from "node:url";

const cliEntry = process.argv[2];
const cliArguments = process.argv.slice(3);
if (cliEntry === undefined) {
  throw new Error("Expected the built CLI entry path.");
}

process.argv = [process.execPath, cliEntry, ...cliArguments];
const onMessage = (message: unknown) => {
  if (
    typeof message !== "object" ||
    message === null ||
    Reflect.get(message, "type") !== "reforce:e2e-signal"
  ) {
    return;
  }
  const signal = Reflect.get(message, "signal");
  if (signal === "SIGINT") {
    process.emit("SIGINT");
  } else if (signal === "SIGBREAK") {
    process.emit("SIGBREAK");
  }
};
process.on("message", onMessage);
try {
  await import(pathToFileURL(cliEntry).href);
} finally {
  process.off("message", onMessage);
  process.disconnect?.();
}
