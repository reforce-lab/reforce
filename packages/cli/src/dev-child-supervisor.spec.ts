import { describe, expect, test } from "bun:test";
import {
  type DevChildExit,
  DevChildSupervisor,
  type ManagedDevChild,
} from "./dev-child-supervisor";

class ManualChild implements ManagedDevChild {
  readonly #exit = Promise.withResolvers<DevChildExit>();
  readonly exited = this.#exit.promise;
  shutdownCount = 0;

  finish(exitCode: number): void {
    this.#exit.resolve({ exitCode });
  }

  async requestShutdown(): Promise<void> {
    this.shutdownCount += 1;
    this.finish(0);
  }
}

async function settleSupervisor(supervisor: DevChildSupervisor): Promise<void> {
  await Promise.resolve();
  await supervisor.whenIdle();
}

describe("development child supervisor", () => {
  test("the same build restarts once and then waits for a new build", async () => {
    const children: ManualChild[] = [];
    const supervisor = new DevChildSupervisor({
      spawn: async () => {
        const child = new ManualChild();
        children.push(child);
        return child;
      },
    });
    await supervisor.acceptSuccessfulBuild("rspack:first");

    children[0]?.finish(1);
    await settleSupervisor(supervisor);
    children[1]?.finish(1);
    await settleSupervisor(supervisor);
    await supervisor.acceptSuccessfulBuild("rspack:first");

    expect(children).toHaveLength(2);
    expect(supervisor.hasLiveChild).toBe(false);
    expect(supervisor.restartCount).toBe(1);
  });

  test("a second failure for one build reports a terminal child failure", async () => {
    const children: ManualChild[] = [];
    const terminalFailures: DevChildExit[] = [];
    const supervisor = new DevChildSupervisor({
      spawn: async () => {
        const child = new ManualChild();
        children.push(child);
        return child;
      },
      onTerminalFailure: (failure) => terminalFailures.push(failure),
    });
    await supervisor.acceptSuccessfulBuild("rspack:first");

    children[0]?.finish(1);
    await settleSupervisor(supervisor);
    children[1]?.finish(1);
    await settleSupervisor(supervisor);

    expect(terminalFailures).toEqual([{ exitCode: 1 }]);
  });

  test("a new build resets the budget and explicitly spawns when no child exists", async () => {
    const buildIds: string[] = [];
    const children: ManualChild[] = [];
    const supervisor = new DevChildSupervisor({
      spawn: async (buildId) => {
        buildIds.push(buildId);
        const child = new ManualChild();
        children.push(child);
        return child;
      },
    });
    await supervisor.acceptSuccessfulBuild("rspack:first");
    children[0]?.finish(1);
    await settleSupervisor(supervisor);
    children[1]?.finish(1);
    await settleSupervisor(supervisor);

    await supervisor.acceptSuccessfulBuild("rspack:second");

    expect(buildIds).toEqual(["rspack:first", "rspack:first", "rspack:second"]);
    expect(supervisor.currentBuildId).toBe("rspack:second");
    expect(supervisor.restartCount).toBe(0);
    expect(supervisor.hasLiveChild).toBe(true);
    await supervisor.shutdown();
  });

  test("a successful child exit completes without consuming restart budget", async () => {
    const children: ManualChild[] = [];
    let naturalExits = 0;
    const supervisor = new DevChildSupervisor({
      spawn: async () => {
        const child = new ManualChild();
        children.push(child);
        return child;
      },
      onNaturalExit: () => {
        naturalExits += 1;
      },
    });
    await supervisor.acceptSuccessfulBuild("rspack:first");

    children[0]?.finish(0);
    await settleSupervisor(supervisor);
    await supervisor.acceptSuccessfulBuild("rspack:second");

    expect(naturalExits).toBe(1);
    expect(children).toHaveLength(1);
    expect(supervisor.restartCount).toBe(0);
  });

  test("shutdown is single-flight and waits for the live child", async () => {
    const child = new ManualChild();
    const supervisor = new DevChildSupervisor({ spawn: async () => child });
    await supervisor.acceptSuccessfulBuild("rspack:first");

    const first = supervisor.shutdown();
    const second = supervisor.shutdown();

    expect(second).toBe(first);
    await first;
    expect(child.shutdownCount).toBe(1);
    expect(supervisor.hasLiveChild).toBe(false);
  });
});
