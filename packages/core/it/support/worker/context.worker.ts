import { parentPort } from "node:worker_threads";
// Node Worker 走 type stripping，不读 tsconfig paths：值导入一律指向本包 dist 产物
// （turbo 让 test 依赖自身 build，dist 新鲜度有保证），类型也只从 dist 取——src 与 dist
// 的同名契约是两套类型身份，混用会在接缝处报错（#207）。
import {
  createApplicationContext,
  factoryBean,
  type GeneratedApplicationDefinition,
  type GeneratedBeanRegistration,
} from "../../../dist/generated-runtime.js";
import { defineBean } from "../../../dist/index.js";

if (!parentPort) {
  throw new Error("Worker message port is unavailable.");
}

const workerResourceId = "src/worker-resource.ts#workerResource";

function workerDefinition(
  registrations: readonly GeneratedBeanRegistration[],
): GeneratedApplicationDefinition {
  return {
    schemaVersion: 6,
    configs: [],
    registrations,
    plans: {
      constructionOrder: [workerResourceId],
      requestConstructionOrder: [],
      startActionOrder: [],
      cleanupActionOrder: [workerResourceId],
    },
  };
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
  workerDefinition([
    factoryBean({
      id: workerResourceId,
      source: {
        file: "src/worker-resource.ts",
        start: { offset: 0, line: 0, character: 0 },
        end: { offset: 0, line: 0, character: 0 },
      },
      definition,
    }),
  ]),
);
await context.start();
const marker = context.get(definition).marker;
await context.close();
parentPort.postMessage({ marker, creations, cleanups });
parentPort.close();
