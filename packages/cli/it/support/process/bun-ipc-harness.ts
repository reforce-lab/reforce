import { type ChildProcess, spawn } from "node:child_process";
import { resolveBunExecutable } from "@reforce/tooling-testing";

const bunExecutable = await resolveBunExecutable();

export interface IpcProcessOutcome {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface BunIpcHarness {
  readonly child: ChildProcess;
  readonly output: () => { readonly stderr: string; readonly stdout: string };
  readonly sendMessage: (message: object) => Promise<void>;
  readonly wait: () => Promise<IpcProcessOutcome>;
  readonly waitForMessage: (message: string) => Promise<unknown>;
}

export function spawnBunIpcHarness(
  harnessPath: string,
  arguments_: readonly string[],
): BunIpcHarness {
  const child = spawn(bunExecutable, [harnessPath, ...arguments_], {
    shell: false,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: unknown) => {
    stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk: unknown) => {
    stderr += String(chunk);
  });
  const messages: unknown[] = [];
  let closedError: Error | undefined;
  const waiters: Array<{
    readonly reject: (error: Error) => void;
    readonly resolve: (message: unknown) => void;
    readonly timeout: ReturnType<typeof setTimeout>;
  }> = [];
  const onMessage = (message: unknown) => {
    const waiter = waiters.shift();
    if (waiter === undefined) {
      messages.push(message);
      return;
    }
    clearTimeout(waiter.timeout);
    waiter.resolve(message);
  };
  child.on("message", onMessage);
  const closeWith = (error: Error) => {
    closedError ??= error;
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timeout);
      waiter.reject(closedError);
    }
  };
  child.on("error", closeWith);
  const completion = new Promise<IpcProcessOutcome>((resolve) => {
    child.once("error", () => resolve({ exitCode: null, signal: null }));
    child.once("exit", (exitCode, signal) => {
      closeWith(
        new Error(
          `Bun harness exited before the expected message (code ${exitCode ?? "null"}, signal ${signal ?? "none"}).\n${stdout}\n${stderr}`,
        ),
      );
      resolve({ exitCode, signal });
    });
  });
  return {
    child,
    output: () => ({ stderr, stdout }),
    async sendMessage(message) {
      if (!child.connected) {
        throw new Error("Bun harness IPC channel is disconnected.");
      }
      await new Promise<void>((resolve, reject) => {
        child.send(message, (error) => {
          if (error !== null) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
    async wait() {
      const outcome = await completion;
      child.off("message", onMessage);
      child.off("error", closeWith);
      return outcome;
    },
    async waitForMessage(timeoutMessage) {
      const queued = messages.shift();
      if (queued !== undefined) {
        return queued;
      }
      if (closedError !== undefined) {
        throw closedError;
      }
      return await new Promise<unknown>((resolve, reject) => {
        const waiter = {
          resolve,
          reject,
          timeout: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) {
              waiters.splice(index, 1);
            }
            reject(new Error(`${timeoutMessage}\n${stdout}\n${stderr}`));
          }, 10_000),
        };
        waiters.push(waiter);
      });
    },
  };
}
