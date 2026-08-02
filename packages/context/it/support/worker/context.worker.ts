import { parentPort } from "node:worker_threads";
import { createApplicationContext, factoryBean } from "@/generated-runtime";
import { defineBean } from "@/index";
import { testDefinition, testSource } from "../../../test/support/test-definition";

if (!parentPort) {
  throw new Error("Worker message port is unavailable.");
}

let creations = 0;
let cleanups = 0;
const definition = defineBean({
  create: () => ({ marker: ++creations }),
  dispose: () => {
    cleanups += 1;
  },
});
const context = createApplicationContext(
  testDefinition([
    factoryBean({
      id: "src/worker-resource.ts#workerResource",
      source: testSource("worker-resource"),
      definition,
    }),
  ]),
);
await context.start();
const marker = context.get(definition).marker;
await context.close();
parentPort.postMessage({ marker, creations, cleanups });
parentPort.close();
