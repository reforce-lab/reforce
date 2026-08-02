import { expect, test } from "bun:test";
import { Worker } from "node:worker_threads";

interface WorkerObservation {
  readonly marker: number;
  readonly creations: number;
  readonly cleanups: number;
}

function runWorker(): Promise<WorkerObservation> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./support/worker/context.worker.ts", import.meta.url));
    worker.once("message", (message: WorkerObservation) => resolve(message));
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Context Worker exited with code ${code}.`));
      }
    });
  });
}

test("separate Workers own independent Context state and cleanup", async () => {
  const observations = await Promise.all([runWorker(), runWorker()]);

  expect(observations).toEqual([
    { marker: 1, creations: 1, cleanups: 1 },
    { marker: 1, creations: 1, cleanups: 1 },
  ]);
});
