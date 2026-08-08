import { DevEntryController } from "@/dev-entry";
import { hotUpdateManifestPattern } from "@/dev-hot-update";
import {
  type DevChildLeaseParticipantMessage,
  type DevChildReadyMessage,
  isDevBuildReadyMessage,
  isDevChildLeaseParticipantAcknowledgement,
  writerLeaseTokenEnvironmentVariable,
} from "@/dev-ipc";
import type { FrameworkLogging } from "@/framework-logging";
import type { RspackHmrRuntime } from "@/hmr-manager";
import { createChildLeaseParticipant } from "@/lease-endpoint";
import { requireNodeExecutable } from "@/node-runtime";
import { PlainTextReporter, reportShutdownFailure } from "@/reporter";
import type { ShutdownResult } from "@/shutdown-controller";
import { withTimeout } from "@/with-timeout";

export interface DevelopmentBootstrapModule {
  bootstrap(): Promise<{ close(): Promise<void> }>;
  // 生成的 bootstrap 的可选导出（RFC 0011 C2/C3）：没装日志绑定的应用它整个不存在，
  // 所以是可选成员而不是可选返回值。
  frameworkLogging?: () => FrameworkLogging | undefined;
}

export interface RunDevelopmentApplicationOptions {
  readonly hot: RspackHmrRuntime;
  readonly loadBootstrap: () => Promise<DevelopmentBootstrapModule>;
  readonly ipcTimeoutMilliseconds?: number;
}

// The parent now only asks for a check once a build validated, so a missing manifest should not
// happen. It stays guarded because rspack keeps only the latest compilation's hot-update output:
// two builds landing back to back can still delete the manifest for the hash this child holds.
// Swallowing that as "no update" keeps the child alive; any other failure must propagate because
// DevHmrManager treats a rejected check as fatal and shuts the child down.
//
// The pattern must track output.hotUpdateMainFilename in bundling/dev-watch.ts. It is `.mjs`, not
// `.json`: the `import` chunk-loading runtime reads `obj.default`, so the manifest is an ES module
// and the runtime would otherwise pick a JSON loader for it (Issue #46).
function isMissingHotUpdateManifest(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  // Node 动态 import 失败的 ERR_MODULE_NOT_FOUND 带 url；path 兜住 fs 系错误形状
  const locations = [Reflect.get(error, "url"), Reflect.get(error, "path")];
  return locations.some(
    (location) =>
      typeof location === "string" && hotUpdateManifestPattern.test(location.replaceAll("\\", "/")),
  );
}

export function createRspackHmrRuntime(hot: RspackHmrRuntime): RspackHmrRuntime {
  return {
    async check(autoApply) {
      try {
        return await hot.check(autoApply);
      } catch (error) {
        if (isMissingHotUpdateManifest(error)) {
          return null;
        }
        throw error;
      }
    },
    async apply() {
      return await hot.apply();
    },
  };
}

function sendToParent(message: object): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (!process.send) {
      reject(new Error("Development child requires a Node.js process IPC channel."));
      return;
    }
    process.send(message, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function waitForParticipantAcknowledgement(
  participantToken: string,
  timeoutMilliseconds: number,
): Promise<void> {
  return withTimeout(
    new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        process.off("disconnect", onDisconnect);
        process.off("message", onMessage);
      };
      const onDisconnect = () => {
        cleanup();
        reject(new Error("Development parent disconnected during lease registration."));
      };
      const onMessage = (message: unknown) => {
        if (!isDevChildLeaseParticipantAcknowledgement(message, participantToken)) {
          return;
        }
        cleanup();
        if (!message.ok) {
          reject(new Error("Development parent rejected the child lease participant."));
          return;
        }
        resolve();
      };
      process.on("disconnect", onDisconnect);
      process.on("message", onMessage);
    }),
    timeoutMilliseconds,
    "Development parent did not acknowledge the child lease participant.",
  );
}

// dev 错误页旗标（#279 两层门的内层；外层是 @reforce/web 错误分派里的 NODE_ENV 守卫）。
// 设置侧放在本模块，是因为它**只进 dev bundle**（CLI 经 reforce:dev-runtime 替换注入，生产
// 构建用的是 production-runtime）：第三方打包器不折叠 NODE_ENV、或生产误设
// NODE_ENV=development 时，这行根本不存在，旗标无人设置，错误页构造性关闭。
// 键字面量必须与 web/src/execution/error-dispatch.ts 的读取侧一致。
//
// REFORCE_DEV_ERROR_PAGE=off 是逃生门：关掉后 dev 也回到与生产同形的脱敏 problem+json。
// 自 #323 起监听面缺省 localhost，错误页不再默认摊给同网段的人；逃生门仍然要留——把
// hostname 显式配成 0.0.0.0 做局域网联调时，带栈与源码的错误页又暴露出去了，那时只有这个
// 开关能单独关掉它。
export function enableDevErrorPage(): void {
  if (process.env.REFORCE_DEV_ERROR_PAGE !== "off") {
    Reflect.set(globalThis, Symbol.for("reforce.devErrorPage"), true);
  }
}

export async function runDevelopmentApplication(
  options: RunDevelopmentApplicationOptions,
): Promise<0 | 1> {
  requireNodeExecutable();
  enableDevErrorPage();
  const reporter = new PlainTextReporter();
  const leaseToken = process.env[writerLeaseTokenEnvironmentVariable];
  let endpoint: Awaited<ReturnType<typeof createChildLeaseParticipant>> | undefined;
  let participantRegistered = false;

  const joinWriterLease = async () => {
    if (participantRegistered) {
      return;
    }
    if (!leaseToken) {
      throw new Error("Development child did not receive its writer lease identity.");
    }
    endpoint = await createChildLeaseParticipant(leaseToken);
    const acknowledgement = waitForParticipantAcknowledgement(
      endpoint.participant.participantToken,
      options.ipcTimeoutMilliseconds ?? 5_000,
    );
    await sendToParent({
      type: "reforce:lease-participant",
      participant: endpoint.participant,
    } satisfies DevChildLeaseParticipantMessage);
    await acknowledgement;
    participantRegistered = true;
  };

  const entry = new DevEntryController({
    hot: options.hot,
    reporter,
    bootstrap: async () => {
      await joinWriterLease();
      const module = await options.loadBootstrap();
      const application = await module.bootstrap();
      // bootstrap 之后才有 logger（它是容器里的一条 bean），而 HMR 每次重载都会走一遍这里，
      // 所以接线也每轮重做。
      entry.attachLogging(module.frameworkLogging?.());
      return application;
    },
  });

  // The parent is the only side that knows a build landed and validated; asking on our own is what
  // used to poison the HMR runtime (Issue #46). A rejected check is fatal by design, so failures
  // reach DevHmrManager rather than being swallowed here.
  const onBuildReady = (message: unknown) => {
    if (!isDevBuildReadyMessage(message)) {
      return;
    }
    void entry.checkForUpdates().catch(() => undefined);
  };

  const runEntry = async (): Promise<ShutdownResult> => {
    try {
      await entry.start();
      if (entry.state === "running") {
        process.on("message", onBuildReady);
        await sendToParent({ type: "reforce:dev-ready" } satisfies DevChildReadyMessage);
      }
      return await entry.finished;
    } catch (error) {
      return await entry.requestShutdown({
        error,
        code: "BOOTSTRAP_FAILED",
        phase: "bootstrap",
        message: "Development child bootstrap failed.",
      });
    }
  };

  const result = await runEntry();
  process.off("message", onBuildReady);
  let exitCode = result.exitCode;
  try {
    await endpoint?.close();
  } catch (error) {
    await reportShutdownFailure({
      reporter,
      command: "dev",
      errors: [...result.errors, error],
    });
    exitCode = 1;
  }
  // Yield one event-loop tick so IPC messages already sent (dev-ready, lease registration)
  // flush to the parent before the channel is disconnected.
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (process.connected) {
    process.disconnect?.();
  }
  return exitCode;
}
