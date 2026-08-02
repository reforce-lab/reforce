import { DevEntryController } from "#internal/dev-entry";
import type { DevTimerScheduler, NodeHmrRuntime } from "#internal/dev-hmr-manager";
import type { CliReporterEvent, Reporter } from "#internal/reporter";

const mode = process.argv[2];
if (mode !== "strict-order" && mode !== "fatal") {
  throw new Error("Unknown development entry fixture mode.");
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
let timersCreated = 0;
let timersCleared = 0;
const timers = new Map<unknown, ReturnType<typeof setInterval>>();
const scheduler: DevTimerScheduler = {
  setInterval(callback, milliseconds) {
    const token = Symbol("timer");
    const timer = setInterval(callback, Math.max(milliseconds, 60_000));
    timer.unref();
    timers.set(token, timer);
    timersCreated += 1;
    return token;
  },
  clearInterval(token) {
    const timer = timers.get(token);
    if (!timer) {
      throw new Error("Unknown development fixture timer.");
    }
    clearInterval(timer);
    timers.delete(token);
    timersCleared += 1;
  },
};

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
const hot: NodeHmrRuntime = {
  accept(specifier) {
    events.push(`accept:${specifier}`);
  },
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
  scheduler,
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
    timersCreated,
    timersCleared,
    listenerDelta: listenersAfter - listenersBefore,
  })}\n`,
);
process.exitCode = result.exitCode;
