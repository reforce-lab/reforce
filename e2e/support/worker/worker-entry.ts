import { parentPort, workerData } from "node:worker_threads";

type Callable = (...arguments_: readonly unknown[]) => unknown;

function requireObject(value: unknown, message: string): object {
  if (typeof value !== "object" || value === null) {
    throw new Error(message);
  }
  return value;
}

function isCallable(value: unknown): value is Callable {
  return typeof value === "function";
}

function requireFunction(value: unknown, message: string): Callable {
  if (!isCallable(value)) {
    throw new Error(message);
  }
  return value;
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== "string") {
    throw new Error(message);
  }
  return value;
}

function requireStringArray(value: unknown, message: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error(message);
  }
  const strings: string[] = [];
  for (const item of value) {
    strings.push(requireString(item, message));
  }
  return strings;
}

function requireNumber(value: unknown, message: string): number {
  if (typeof value !== "number") {
    throw new Error(message);
  }
  return value;
}

// #207：入口模块改由 spec 在打包期静态拼装（worker-bundle-entry.ts），本文件只保留观察
// 逻辑——esbuild/SWC 需要静态 import 才能把带 TC39 装饰器的应用源码降级进 bundle，
// 运行期动态 import .ts 在 Node 下既无 tsconfig paths 也无装饰器支持。
export async function observeApplication(
  bootstrapModule: unknown,
  applicationModule: unknown,
): Promise<void> {
  if (parentPort === null) {
    throw new Error("Generated application Worker requires a parent message port.");
  }
  if (typeof workerData !== "string") {
    throw new Error("Generated application Worker requires a string label.");
  }

  const bootstrapExports = requireObject(
    bootstrapModule,
    "Generated bootstrap module must be an object.",
  );
  const applicationExports = requireObject(
    applicationModule,
    "Generated application module must be an object.",
  );
  const bootstrap = requireFunction(
    Reflect.get(bootstrapExports, "bootstrap"),
    "Generated bootstrap module must export bootstrap().",
  );
  const contextValue: unknown = await Reflect.apply(bootstrap, undefined, []);
  const context = requireObject(contextValue, "Generated bootstrap must return a Context.");
  const getBean = requireFunction(
    Reflect.get(context, "get"),
    "Generated Context must expose get().",
  );
  const close = requireFunction(
    Reflect.get(context, "close"),
    "Generated Context must expose close().",
  );
  const greetingServiceToken = Reflect.get(applicationExports, "GreetingService");
  const selectionProbeToken = Reflect.get(applicationExports, "SelectionProbe");
  const alphaToken = Reflect.get(applicationExports, "AlphaService");
  const resourceToken = Reflect.get(applicationExports, "managedResource");
  const lifecycleSnapshot = requireFunction(
    Reflect.get(applicationExports, "lifecycleSnapshot"),
    "Application module must export lifecycleSnapshot().",
  );

  function resolveBean(token: unknown): object {
    return requireObject(
      Reflect.apply(getBean, context, [token]),
      "Generated Context returned an invalid Bean.",
    );
  }

  const greetingService = resolveBean(greetingServiceToken);
  const greet = requireFunction(
    Reflect.get(greetingService, "greet"),
    "GreetingService must expose greet().",
  );
  const greeting = requireString(
    Reflect.apply(greet, greetingService, []),
    "GreetingService greet() must return a string.",
  );
  const selectionProbe = resolveBean(selectionProbeToken);
  const values = requireFunction(
    Reflect.get(selectionProbe, "values"),
    "SelectionProbe must expose values().",
  );
  const selection = requireStringArray(
    Reflect.apply(values, selectionProbe, []),
    "SelectionProbe values() must return strings.",
  );
  const alpha = resolveBean(alphaToken);
  const repeatedAlpha = resolveBean(alphaToken);
  const beta = requireObject(Reflect.get(alpha, "beta"), "AlphaService must expose beta.");
  const cycleProxy = requireObject(
    Reflect.get(beta, "alpha"),
    "BetaService must expose its AlphaService dependency.",
  );
  const resourceHandle = requireObject(
    Reflect.get(alpha, "resource"),
    "AlphaService must expose its Lazy resource.",
  );
  const getResource = requireFunction(
    Reflect.get(resourceHandle, "get"),
    "Lazy resource must expose get().",
  );
  const lazyResource = requireObject(
    Reflect.apply(getResource, resourceHandle, []),
    "Lazy resource returned an invalid value.",
  );
  const repeatedLazyResource = requireObject(
    Reflect.apply(getResource, resourceHandle, []),
    "Lazy resource returned an invalid repeated value.",
  );
  const directResource = resolveBean(resourceToken);
  const beforeClose: unknown = Reflect.apply(lifecycleSnapshot, applicationExports, []);
  const runtimeObservation = {
    greeting,
    selection,
    singleton: alpha === repeatedAlpha,
    alphaMarker: requireNumber(
      Reflect.get(alpha, "marker"),
      "AlphaService marker must be a number.",
    ),
    cycleProxyDistinct: cycleProxy !== alpha,
    cycleProxyMarker: requireNumber(
      Reflect.get(cycleProxy, "marker"),
      "Cycle proxy marker must be a number.",
    ),
    lazySingleton: lazyResource === repeatedLazyResource && lazyResource === directResource,
    resourceMarker: requireNumber(
      Reflect.get(lazyResource, "marker"),
      "Managed resource marker must be a number.",
    ),
  };
  await Promise.all([
    Reflect.apply(close, context, []),
    Reflect.apply(close, context, []),
    Reflect.apply(close, context, []),
  ]);
  await Reflect.apply(close, context, []);

  parentPort.postMessage({
    label: workerData,
    ...runtimeObservation,
    beforeClose,
    afterClose: Reflect.apply(lifecycleSnapshot, applicationExports, []),
  });
  parentPort.close();
}
