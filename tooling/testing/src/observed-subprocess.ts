import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

export interface SubprocessRegistry {
  track(child: ChildProcess, completion: Promise<number | null>): void;
  forget(child: ChildProcess): void;
  killAll(): Promise<void>;
}

// 每个 spec 建自己的 registry 并从自己的 afterEach 调 killAll：vitest 每个 spec 文件一个独立 fork，
// 模块级的共享数组和模块级的 afterEach 都会跨文件串台（Issue #35）。
export function createSubprocessRegistry(): SubprocessRegistry {
  const tracked: Array<{
    readonly child: ChildProcess;
    readonly completion: Promise<number | null>;
  }> = [];
  return {
    track(child, completion) {
      tracked.push({ child, completion });
    },
    forget(child) {
      const index = tracked.findIndex((entry) => entry.child === child);
      if (index >= 0) {
        tracked.splice(index, 1);
      }
    },
    async killAll() {
      for (const entry of tracked.splice(0).reverse()) {
        entry.child.kill();
        await entry.completion.catch(() => undefined);
      }
    },
  };
}

export type TimeoutGuard = <T>(promise: Promise<T>, message: string) => Promise<T>;

// 超时值由调用方给：各 spec 对「多久算卡住」的容忍度不同，统一成一个常数会悄悄放松更严的那一侧。
export function createTimeoutGuard(timeoutMilliseconds: number): TimeoutGuard {
  return async (promise, message) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(message)), timeoutMilliseconds);
        }),
      ]);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  };
}

export async function send(child: ChildProcess, message: object): Promise<void> {
  if (child.send === undefined) {
    throw new Error("Harness has no IPC channel.");
  }
  await new Promise<void>((resolve, reject) => {
    child.send?.(message, (error) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export interface TypedMessageObserver {
  readonly messageCount: (type: string) => number;
  barrier(): Promise<void>;
}

export function observeTypedMessages(input: {
  readonly child: ChildProcess;
  readonly handlers: ReadonlyMap<string, (message: object) => void>;
  readonly withTimeout: TimeoutGuard;
  readonly barrierTimeoutMessage: string;
  // 在按 type 分派之前先看一眼消息；返回 true 表示已消费，不计数也不分派。
  readonly consume?: (message: unknown) => boolean;
}): TypedMessageObserver {
  const { child, handlers, withTimeout, barrierTimeoutMessage, consume } = input;
  const barriers = new Map<string, () => void>();
  const counts = new Map<string, number>();
  child.on("message", (message: unknown) => {
    if (consume?.(message) === true) {
      return;
    }
    if (typeof message !== "object" || message === null) {
      return;
    }
    const type = Reflect.get(message, "type");
    if (typeof type !== "string") {
      return;
    }
    counts.set(type, (counts.get(type) ?? 0) + 1);
    if (type === "harness:barrier-ack") {
      const requestId = Reflect.get(message, "requestId");
      if (typeof requestId === "string") {
        barriers.get(requestId)?.();
        barriers.delete(requestId);
      }
      return;
    }
    handlers.get(type)?.(message);
  });
  return {
    messageCount: (type) => counts.get(type) ?? 0,
    async barrier() {
      const requestId = randomUUID();
      const acknowledgement = Promise.withResolvers<void>();
      barriers.set(requestId, acknowledgement.resolve);
      await send(child, { type: "harness:barrier", requestId });
      await withTimeout(acknowledgement.promise, barrierTimeoutMessage);
    },
  };
}
