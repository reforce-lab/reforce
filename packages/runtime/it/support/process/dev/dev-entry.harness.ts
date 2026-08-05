// 本文件由 Node 子进程直接执行（type stripping，不读 tsconfig paths）：值导入一律指向包内
// dist 产物或带显式 .ts 扩展名的相对路径；type-only 导入会被擦除，保留 @/ 别名（#207）。

import type { RspackHmrRuntime } from "@/hmr-manager";
import type { CliReporterEvent, Reporter } from "@/reporter";
import { DevEntryController } from "../../../../dist/dev-entry.js";

const mode = process.argv[2];
if (mode !== "strict-order" && mode !== "fatal") {
  throw new Error("Unknown development entry harness mode.");
}

const listenerEvents = [
  ...(process.platform === "win32" ? ["SIGINT", "SIGBREAK"] : ["SIGINT", "SIGTERM"]),
  "message",
  "disconnect",
];
const listenerCount = () =>
  listenerEvents.reduce((count, event) => count + process.listenerCount(event), 0);
const listenersBefore = listenerCount();
const events: string[] = [];

const fatalError = new Error("check fatal");
const cleanupError = new Error("cleanup fatal");
const flushError = new Error("flush fatal");
const reporter: Reporter = {
  report(event: CliReporterEvent) {
    events.push(event.kind === "failure" ? `report:${event.code}` : `report:${event.kind}`);
  },
  async flush() {
    events.push("flush");
    if (mode === "fatal") {
      throw flushError;
    }
  },
};

let generation = 1;
const hot: RspackHmrRuntime = {
  async check(autoApply) {
    events.push(`check:${autoApply}`);
    if (mode === "fatal") {
      throw fatalError;
    }
    return ["reforce:application-bootstrap"];
  },
  async apply() {
    events.push("apply");
    generation = 2;
  },
};

const entry = new DevEntryController({
  hot,
  reporter,
  bootstrap: async () => {
    const currentGeneration = generation;
    events.push(`bootstrap:${currentGeneration}`);
    return {
      async close() {
        events.push(`close:${currentGeneration}`);
        if (mode === "fatal") {
          throw cleanupError;
        }
      },
    };
  },
});
await entry.start();
try {
  await entry.checkForUpdates();
} catch (error) {
  events.push(`check-rejected:${error instanceof Error ? error.message : String(error)}`);
}
if (mode === "strict-order") {
  void entry.requestShutdown();
}
const result = await entry.finished;
const listenersAfter = listenerCount();
const errorMessages = result.errors.map((error) =>
  error instanceof Error ? error.message : String(error),
);
process.stdout.write(
  `${JSON.stringify({
    events,
    exitCode: result.exitCode,
    primaryError:
      result.primaryError instanceof Error
        ? result.primaryError.message
        : result.primaryError === undefined
          ? undefined
          : String(result.primaryError),
    errorMessages,
    listenerDelta: listenersAfter - listenersBefore,
  })}\n`,
);
process.exitCode = result.exitCode;
