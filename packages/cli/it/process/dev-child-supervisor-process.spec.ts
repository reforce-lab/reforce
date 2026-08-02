import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { resolveBunExecutable } from "@reforce/tooling-testing";
import { execa } from "execa";
import { DevChildSupervisor, type ManagedDevChild } from "@/dev-child-supervisor";

const harnessPath = fileURLToPath(
  new URL("../support/process/dev/dev-child-exit.harness.ts", import.meta.url),
);
const bunExecutable = await resolveBunExecutable();

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for development child state.");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

test("real child processes obey restart budget and never overlap", async () => {
  const exitCodes = [1, 1, 0];
  let liveChildren = 0;
  let maximumLiveChildren = 0;
  let spawnCount = 0;
  let naturalExits = 0;
  const supervisor = new DevChildSupervisor({
    spawn: async (): Promise<ManagedDevChild> => {
      const exitCode = exitCodes[spawnCount];
      if (exitCode === undefined) {
        throw new Error("Unexpected development child spawn.");
      }
      spawnCount += 1;
      liveChildren += 1;
      maximumLiveChildren = Math.max(maximumLiveChildren, liveChildren);
      const subprocess = execa(bunExecutable, [harnessPath, String(exitCode)], {
        reject: false,
        shell: false,
      });
      const exited = subprocess.then((result) => {
        liveChildren -= 1;
        return {
          exitCode: result.exitCode ?? null,
          ...(result.signal === undefined ? {} : { signalName: result.signal }),
        };
      });
      return {
        exited,
        async requestShutdown(signal) {
          if (signal) {
            subprocess.kill(signal);
          }
        },
      };
    },
    onNaturalExit: () => {
      naturalExits += 1;
    },
  });

  await supervisor.acceptSuccessfulBuild("rspack:first");
  await waitUntil(() => spawnCount === 2 && !supervisor.hasLiveChild);
  await supervisor.acceptSuccessfulBuild("rspack:first");
  expect(spawnCount).toBe(2);

  await supervisor.acceptSuccessfulBuild("rspack:second");
  await waitUntil(() => naturalExits === 1);

  expect(spawnCount).toBe(3);
  expect(maximumLiveChildren).toBe(1);
  expect(supervisor.restartCount).toBe(0);
});
