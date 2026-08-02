import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

function runWorker(workerEntry, label) {
  return new Promise((resolveObservation, reject) => {
    const worker = new Worker(pathToFileURL(workerEntry), { workerData: label });
    let observation;
    worker.once("message", (message) => {
      observation = message;
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Generated application Worker exited with code ${code}.`));
        return;
      }
      if (observation === undefined) {
        reject(new Error("Generated application Worker exited without an observation."));
        return;
      }
      resolveObservation(observation);
    });
  });
}

const workerEntry = process.argv[2];
if (workerEntry === undefined) {
  throw new Error("Built generated application Worker entry is required.");
}

const absoluteEntry = resolve(workerEntry);
const observations = await Promise.all([
  runWorker(absoluteEntry, "first"),
  runWorker(absoluteEntry, "second"),
]);
process.stdout.write(`${JSON.stringify(observations)}\n`);
