import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  isShutdownAcknowledgementMessage,
  type ShutdownRequestMessage,
} from "@reforce/runtime/dev-ipc";
import { withTimeout } from "@reforce/runtime/with-timeout";

interface ProductionChildResult {
  readonly exitCode?: number;
}

export interface ProductionChild {
  getOneMessage(): Promise<unknown>;
  sendMessage(message: ShutdownRequestMessage | LeaseParticipantAck): Promise<void>;
  // 「请关停」的唯一入口：用什么手段关停由子进程句柄决定，调用方不做平台判断。
  requestShutdown(signal: NodeJS.Signals): Promise<void>;
  kill(signal: NodeJS.Signals): void;
  wait(): Promise<ProductionChildResult>;
}

// Sender half of the production-wire acknowledgement validated by `isLeaseParticipantAck` in
// production-runtime.ts. Unlike the dev wire's `DevChildLeaseParticipantAcknowledgement`
// (dev-ipc.ts), it carries no `ok`: this parent only acks after `lease.addParticipant` has
// succeeded, and a failure there fails the command instead of nacking the child.
export interface LeaseParticipantAck {
  readonly type: "reforce:lease-participant-ack";
  readonly participantToken: string;
}

class BunProductionChild implements ProductionChild {
  private readonly completion: Promise<ProductionChildResult>;
  private readonly messages: unknown[] = [];
  private readonly messageWaiters: Array<{
    readonly reject: (error: Error) => void;
    readonly resolve: (message: unknown) => void;
  }> = [];
  private readonly process: ChildProcess;
  private terminalError: Error | undefined;

  constructor(process: ChildProcess) {
    this.process = process;
    process.on("message", (message: unknown) => {
      const waiter = this.messageWaiters.shift();
      if (waiter) {
        waiter.resolve(message);
        return;
      }
      this.messages.push(message);
    });
    this.completion = new Promise((resolve, reject) => {
      process.once("error", (error) => {
        this.closeInbox(error);
        reject(error);
      });
      process.once("exit", (exitCode, signal) => {
        this.closeInbox(
          new Error(
            `Production child exited before its IPC message (code ${exitCode ?? "null"}, signal ${signal ?? "none"}).`,
          ),
        );
        resolve(exitCode === null ? {} : { exitCode });
      });
    });
  }

  getOneMessage(): Promise<unknown> {
    const message = this.messages.shift();
    if (message !== undefined) {
      return Promise.resolve(message);
    }
    if (this.terminalError) {
      return Promise.reject(this.terminalError);
    }
    return new Promise((resolve, reject) => this.messageWaiters.push({ resolve, reject }));
  }

  async sendMessage(message: ShutdownRequestMessage | LeaseParticipantAck): Promise<void> {
    if (!this.process.connected) {
      throw new Error("The production child IPC channel is unavailable.");
    }
    await new Promise<void>((resolve, reject) => {
      this.process.send(message, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  // Windows has no POSIX signal semantics: `child.kill("SIGTERM")` there maps to TerminateProcess
  // and the child gets no chance to shut down gracefully. On win32 shutdown must instead go through
  // the IPC handshake (`reforce:shutdown` out, `reforce:shutdown-ack` back), so the child can run
  // its own shutdown path. The branch belongs here rather than in the command flow: callers only
  // ever want "shut this child down", and a platform check in the caller gets copied by the next one.
  async requestShutdown(signal: NodeJS.Signals): Promise<void> {
    if (process.platform !== "win32") {
      this.kill(signal);
      return;
    }
    const requestId = randomUUID();
    await this.sendMessage({ type: "reforce:shutdown", requestId });
    for (;;) {
      const message = await nextMessage(this, 30_000);
      if (isShutdownAcknowledgementMessage(message) && message.requestId === requestId) {
        if (!message.ok) {
          throw new Error("The production child reported a shutdown failure.");
        }
        return;
      }
    }
  }

  kill(signal: NodeJS.Signals): void {
    this.process.kill(signal);
  }

  wait(): Promise<ProductionChildResult> {
    return this.completion;
  }

  private closeInbox(error: Error): void {
    this.terminalError ??= error;
    for (const waiter of this.messageWaiters.splice(0)) {
      waiter.reject(this.terminalError);
    }
  }
}

export function spawnProductionChild(input: {
  readonly executable: string;
  readonly entryPath: string;
  readonly projectRoot: string;
  readonly leaseToken: string;
}): ProductionChild {
  return new BunProductionChild(
    spawn(input.executable, [input.entryPath], {
      cwd: input.projectRoot,
      env: { ...process.env, REFORCE_LEASE_TOKEN: input.leaseToken },
      shell: false,
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      windowsHide: true,
    }),
  );
}

export function nextMessage(child: ProductionChild, timeoutMilliseconds: number): Promise<unknown> {
  return withTimeout(
    child.getOneMessage(),
    timeoutMilliseconds,
    "The production child IPC handshake timed out.",
  );
}
