import { describe, expect, test } from "bun:test";
import type { CompilerDiagnostic } from "@reforce/compiler";
import { DevCommandController } from "@/commands/dev";
import { DevChildSupervisor, type ManagedDevChild } from "@/dev/child-supervisor";
import { DevWatchCoordinator } from "@/dev/watch-coordinator";
import type { CliReporterEvent, Reporter } from "@/reporter";

class RecordingReporter implements Reporter {
  readonly events: CliReporterEvent[] = [];
  flushCount = 0;

  report(event: CliReporterEvent): void {
    this.events.push(event);
  }

  async flush(): Promise<void> {
    this.flushCount += 1;
  }
}

function runningChild(events?: string[]): ManagedDevChild {
  let finish: (exit: { readonly exitCode: number }) => void = () => undefined;
  const exited = new Promise<{ readonly exitCode: number }>((resolve) => {
    finish = resolve;
  });
  return {
    exited,
    async notifyBuildReady(buildId) {
      events?.push(`child build ready:${buildId}`);
    },
    async requestShutdown() {
      events?.push("child shutdown");
      finish({ exitCode: 0 });
    },
  };
}

const diagnostic: CompilerDiagnostic = {
  kind: "compiler",
  code: "PARSER_SYNTAX_ERROR",
  severity: "error",
  message: "broken source",
  related: [],
};

describe("development watch coordination", () => {
  test("a failed build preserves the healthy child and build identity", async () => {
    const reporter = new RecordingReporter();
    const child = runningChild();
    let spawnCount = 0;
    const supervisor = new DevChildSupervisor({
      spawn: async () => {
        spawnCount += 1;
        return child;
      },
    });
    const coordinator = new DevWatchCoordinator({ reporter, supervisor });
    await coordinator.acceptCompilation({
      status: "success",
      buildId: "rspack:healthy",
      validateAssets: async () => undefined,
    });

    await coordinator.acceptCompilation({
      status: "failure",
      diagnostics: [diagnostic],
    });

    expect(coordinator.healthyBuildId).toBe("rspack:healthy");
    expect(supervisor.hasLiveChild).toBe(true);
    expect(spawnCount).toBe(1);
    expect(reporter.events.map((event) => event.kind)).toEqual(["diagnostic", "status"]);
    await supervisor.shutdown();
  });

  test("a successful build validates complete assets before first spawn", async () => {
    const order: string[] = [];
    const supervisor = new DevChildSupervisor({
      spawn: async () => {
        order.push("spawn");
        return runningChild();
      },
    });
    const coordinator = new DevWatchCoordinator({
      reporter: new RecordingReporter(),
      supervisor,
    });

    await coordinator.acceptCompilation({
      status: "success",
      buildId: "rspack:healthy",
      validateAssets: async () => {
        order.push("validate");
      },
    });

    expect(order).toEqual(["validate", "spawn"]);
    await supervisor.shutdown();
  });

  test("invalid assets preserve the previous healthy child", async () => {
    const reporter = new RecordingReporter();
    const child = runningChild();
    let spawnCount = 0;
    const supervisor = new DevChildSupervisor({
      spawn: async () => {
        spawnCount += 1;
        return child;
      },
    });
    const coordinator = new DevWatchCoordinator({ reporter, supervisor });
    await coordinator.acceptCompilation({
      status: "success",
      buildId: "rspack:healthy",
      validateAssets: async () => undefined,
    });

    await coordinator.acceptCompilation({
      status: "success",
      buildId: "rspack:invalid",
      validateAssets: async () => {
        throw new Error("missing chunk");
      },
    });

    expect(coordinator.healthyBuildId).toBe("rspack:healthy");
    expect(supervisor.hasLiveChild).toBe(true);
    expect(spawnCount).toBe(1);
    expect(reporter.events.at(-1)).toMatchObject({
      kind: "failure",
      code: "ARTIFACT_INVALID",
    });
    await supervisor.shutdown();
  });

  test("command shutdown closes watcher before child and flushes once", async () => {
    const events: string[] = [];
    const reporter = new RecordingReporter();
    const supervisor = new DevChildSupervisor({
      spawn: async () => runningChild(events),
    });
    await supervisor.acceptSuccessfulBuild("rspack:healthy");
    const coordinator = new DevWatchCoordinator({ reporter, supervisor });
    const command = new DevCommandController({
      watch: {
        async close() {
          events.push("watch close");
        },
      },
      watchCoordinator: coordinator,
      supervisor,
      reporter,
    });

    const first = command.shutdown("SIGTERM");
    const second = command.shutdown("SIGTERM");

    expect(second).toBe(first);
    await first;
    expect(events).toEqual(["watch close", "child shutdown"]);
    expect(reporter.flushCount).toBe(1);
  });
});
