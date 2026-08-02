import { parentPort, workerData } from "node:worker_threads";
import { bootstrap } from "./project/.reforce/generated/bootstrap";
import { AlphaService, lifecycleSnapshot, managedResource } from "./project/src/application";

if (parentPort === null) {
  throw new Error("Generated application Worker requires a parent message port.");
}
if (typeof workerData !== "string") {
  throw new Error("Generated application Worker requires a string label.");
}

const context = await bootstrap();
const alpha = context.get(AlphaService);
const repeatedAlpha = context.get(AlphaService);
const cycleProxy = alpha.beta.alpha;
const lazyResource = alpha.resource.get();
const repeatedLazyResource = alpha.resource.get();
const directResource = context.get(managedResource);
const beforeClose = lifecycleSnapshot();
const runtimeObservation = {
  singleton: alpha === repeatedAlpha,
  alphaMarker: alpha.marker,
  cycleProxyDistinct: cycleProxy !== alpha,
  cycleProxyMarker: cycleProxy.marker,
  lazySingleton: lazyResource === repeatedLazyResource && lazyResource === directResource,
  resourceMarker: lazyResource.marker,
};
await Promise.all([context.close(), context.close(), context.close()]);
await context.close();

parentPort.postMessage({
  label: workerData,
  ...runtimeObservation,
  beforeClose,
  afterClose: lifecycleSnapshot(),
});
parentPort.close();
