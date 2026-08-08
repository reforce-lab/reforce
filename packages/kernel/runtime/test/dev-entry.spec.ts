import { describe, expect, test } from "vitest";
import { DevEntryController } from "@/dev-entry";
import type { FrameworkLogging } from "@/framework-logging";
import type { RspackHmrRuntime } from "@/hmr-manager";
import type { CliReporterEvent, Reporter } from "@/reporter";

// RFC #242 L6【已定】把 HMR 与 context 启动一并列为运行期框架输出，走 Logger。dev 侧此前
// 一条都没接：崩溃是 Node 裸 dump、引导缓冲照丢、关停全程静默。
const idleRuntime: RspackHmrRuntime = {
  check: () => Promise.resolve(null),
  apply: () => Promise.resolve(undefined),
};

function reporterDouble(): { readonly reporter: Reporter; readonly events: CliReporterEvent[] } {
  const events: CliReporterEvent[] = [];
  return {
    events,
    reporter: { report: (event) => events.push(event), flush: () => Promise.resolve() },
  };
}

function loggingDouble(): {
  readonly logging: FrameworkLogging;
  readonly records: { message: string }[];
} {
  const records: { message: string }[] = [];
  return {
    records,
    logging: {
      logger: {
        fatal: (_fields, message) => records.push({ message }),
        info: (_fields, message) => records.push({ message }),
      },
      factory: {},
    },
  };
}

// 进程内用例一律不装进程 handler（既有开关），所以这里只钉「logger 有没有被交到关停面上」。
function controllerOf(bootstrap: () => Promise<{ close(): Promise<void> }>) {
  const { reporter } = reporterDouble();
  return new DevEntryController({
    hot: idleRuntime,
    reporter,
    bootstrap,
    installProcessHandlers: false,
  });
}

describe("DevEntryController logging handover", () => {
  test("logs the shutdown once a bootstrap has handed its logger over", async () => {
    const { logging, records } = loggingDouble();
    const controller = controllerOf(async () => ({ close: async () => undefined }));
    await controller.start();
    controller.attachLogging(logging);

    await controller.requestShutdown();

    expect(records.map((record) => record.message)).toContain("stopped");
  });

  // HMR 每次重载都换掉整个 bootstrap 模块，上一轮那个 logger 的 sink 可能已经关了。
  test("takes the newest logger when a hot reload hands over a second one", async () => {
    const first = loggingDouble();
    const second = loggingDouble();
    const controller = controllerOf(async () => ({ close: async () => undefined }));
    await controller.start();

    controller.attachLogging(first.logging);
    controller.attachLogging(second.logging);
    await controller.requestShutdown();

    expect(first.records).toEqual([]);
    expect(second.records.map((record) => record.message)).toContain("stopped");
  });

  // 没装日志绑定的应用 frameworkLogging 整个不存在，dev 照旧安静地跑完。
  test("stays silent when the bootstrap exposes no logging", async () => {
    const controller = controllerOf(async () => ({ close: async () => undefined }));
    await controller.start();

    controller.attachLogging(undefined);

    expect((await controller.requestShutdown()).exitCode).toBe(0);
  });
});
