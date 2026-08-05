import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { TransactionIsolationOnJoinError, TransactionSavepointUnsupportedError } from "@/errors";
import type { MethodInterceptor, MethodInvocationContext } from "@/interception/interceptor";
import { TransactionInterceptor } from "@/transaction/interceptor";
import type { TransactionManager, TransactionOptions } from "@/transaction/manager";
import type { TransactionalValue } from "@/transaction/marker";
import { activeTransaction } from "@/transaction/scope";

// 传播语义与回滚规则（ADR 0008 T3，#204 定案 5）。manager 是外部副作用边界，用记录调用序的
// fake 替身；断言的是拦截器对契约的调用协议——begin/commit/rollback/savepoint 的次序与配对。

interface ManagerEvent {
  readonly op: "begin" | "commit" | "rollback" | "savepoint" | "release" | "rollback-to-savepoint";
  readonly resource: string;
  readonly isolation?: TransactionOptions["isolation"];
}

interface RecordingManager {
  readonly manager: TransactionManager<string>;
  readonly events: ManagerEvent[];
}

function recordingManager(options: { readonly savepoints: boolean }): RecordingManager {
  const events: ManagerEvent[] = [];
  let sequence = 0;
  const manager: TransactionManager<string> = {
    async withTransaction<T>(
      transactionOptions: TransactionOptions,
      fn: (resource: string) => Promise<T>,
    ): Promise<T> {
      sequence += 1;
      const resource = `tx${sequence}`;
      events.push({ op: "begin", resource, isolation: transactionOptions.isolation });
      try {
        const result = await fn(resource);
        events.push({ op: "commit", resource });
        return result;
      } catch (error) {
        events.push({ op: "rollback", resource });
        throw error;
      }
    },
  };
  if (!options.savepoints) {
    return { manager, events };
  }
  return {
    manager: {
      ...manager,
      async withSavepoint<T>(resource: string, fn: (resource: string) => Promise<T>): Promise<T> {
        sequence += 1;
        const savepoint = `sp${sequence}@${resource}`;
        events.push({ op: "savepoint", resource: savepoint });
        try {
          const result = await fn(savepoint);
          events.push({ op: "release", resource: savepoint });
          return result;
        } catch (error) {
          events.push({ op: "rollback-to-savepoint", resource: savepoint });
          throw error;
        }
      },
    },
    events,
  };
}

function contextOf(
  value: TransactionalValue | undefined,
): MethodInvocationContext<TransactionalValue | undefined> {
  return { beanId: "app#Orders", method: "save", args: [], value };
}

function boundary(
  interceptor: TransactionInterceptor,
  value: TransactionalValue | undefined,
  next: () => Promise<unknown>,
): Promise<unknown> {
  return interceptor.intercept(contextOf(value), next);
}

function ops(events: readonly ManagerEvent[]): readonly string[] {
  return events.map((event) => event.op);
}

describe("TransactionInterceptor propagation", () => {
  test("REQUIRED outside a transaction begins a new one and commits on return", async () => {
    const { manager, events } = recordingManager({ savepoints: true });
    const interceptor = new TransactionInterceptor(manager);

    const result = await boundary(interceptor, undefined, async () => {
      expect(activeTransaction()?.resource).toBe("tx1");
      return "saved";
    });

    expect(result).toBe("saved");
    expect(events).toEqual([
      { op: "begin", resource: "tx1", isolation: undefined },
      { op: "commit", resource: "tx1" },
    ]);
    expect(activeTransaction()).toBeUndefined();
  });

  test("REQUIRED inside a transaction joins the same resource without a new boundary", async () => {
    const { manager, events } = recordingManager({ savepoints: true });
    const interceptor = new TransactionInterceptor(manager);

    await boundary(interceptor, undefined, () =>
      boundary(interceptor, { propagation: "REQUIRED" }, async () => {
        expect(activeTransaction()?.resource).toBe("tx1");
        return undefined;
      }),
    );

    expect(ops(events)).toEqual(["begin", "commit"]);
  });

  test("REQUIRES_NEW outside a transaction begins a new one", async () => {
    const { manager, events } = recordingManager({ savepoints: true });
    const interceptor = new TransactionInterceptor(manager);

    await boundary(interceptor, { propagation: "REQUIRES_NEW" }, async () => undefined);

    expect(ops(events)).toEqual(["begin", "commit"]);
  });

  test("REQUIRES_NEW inside a transaction suspends the outer one and restores it", async () => {
    const { manager, events } = recordingManager({ savepoints: true });
    const interceptor = new TransactionInterceptor(manager);

    await boundary(interceptor, undefined, async () => {
      await boundary(interceptor, { propagation: "REQUIRES_NEW" }, async () => {
        expect(activeTransaction()?.resource).toBe("tx2");
        return undefined;
      });
      expect(activeTransaction()?.resource).toBe("tx1");
      return undefined;
    });

    expect(events).toEqual([
      { op: "begin", resource: "tx1", isolation: undefined },
      { op: "begin", resource: "tx2", isolation: undefined },
      { op: "commit", resource: "tx2" },
      { op: "commit", resource: "tx1" },
    ]);
  });

  test("NESTED outside a transaction begins a new one like REQUIRED", async () => {
    const { manager, events } = recordingManager({ savepoints: false });
    const interceptor = new TransactionInterceptor(manager);

    await boundary(interceptor, { propagation: "NESTED" }, async () => undefined);

    expect(ops(events)).toEqual(["begin", "commit"]);
  });

  test("NESTED inside a transaction runs in a savepoint on the same transaction", async () => {
    const { manager, events } = recordingManager({ savepoints: true });
    const interceptor = new TransactionInterceptor(manager);

    await boundary(interceptor, undefined, () =>
      boundary(interceptor, { propagation: "NESTED" }, async () => {
        expect(activeTransaction()?.resource).toBe("sp2@tx1");
        return undefined;
      }),
    );

    expect(ops(events)).toEqual(["begin", "savepoint", "release", "commit"]);
  });

  test("a new transaction carries its declared isolation into the manager and the record", async () => {
    const { manager, events } = recordingManager({ savepoints: true });
    const interceptor = new TransactionInterceptor(manager);

    await boundary(interceptor, { isolation: "SERIALIZABLE" }, async () => {
      expect(activeTransaction()?.isolation).toBe("SERIALIZABLE");
      return undefined;
    });

    expect(events[0]).toEqual({ op: "begin", resource: "tx1", isolation: "SERIALIZABLE" });
  });
});

describe("TransactionInterceptor rollback rules", () => {
  test("N1: NESTED never degrades when the manager lacks savepoints", async () => {
    const { manager, events } = recordingManager({ savepoints: false });
    const interceptor = new TransactionInterceptor(manager);
    let innerRan = false;

    const outcome = boundary(interceptor, undefined, () =>
      boundary(interceptor, { propagation: "NESTED" }, async () => {
        innerRan = true;
        return undefined;
      }),
    );

    await expect(outcome).rejects.toBeInstanceOf(TransactionSavepointUnsupportedError);
    expect(innerRan).toBe(false);
    expect(ops(events)).toEqual(["begin", "rollback"]);
  });

  test("N2: a joining boundary declaring a different isolation is rejected, not ignored", async () => {
    const { manager } = recordingManager({ savepoints: true });
    const interceptor = new TransactionInterceptor(manager);
    let innerRan = false;

    const outcome = boundary(interceptor, { isolation: "READ_COMMITTED" }, () =>
      boundary(interceptor, { isolation: "SERIALIZABLE" }, async () => {
        innerRan = true;
        return undefined;
      }),
    );

    await expect(outcome).rejects.toBeInstanceOf(TransactionIsolationOnJoinError);
    expect(innerRan).toBe(false);
  });

  test("N2: declaring isolation over an outer transaction that declared none is rejected", async () => {
    const { manager } = recordingManager({ savepoints: true });
    const interceptor = new TransactionInterceptor(manager);

    const outcome = boundary(interceptor, undefined, () =>
      boundary(interceptor, { isolation: "READ_COMMITTED" }, async () => undefined),
    );

    await expect(outcome).rejects.toBeInstanceOf(TransactionIsolationOnJoinError);
  });

  test("N2: a joining boundary with the same declared isolation passes", async () => {
    const { manager, events } = recordingManager({ savepoints: true });
    const interceptor = new TransactionInterceptor(manager);

    await boundary(interceptor, { isolation: "SERIALIZABLE" }, () =>
      boundary(interceptor, { isolation: "SERIALIZABLE" }, async () => undefined),
    );

    expect(ops(events)).toEqual(["begin", "commit"]);
  });

  test("N2: a savepoint boundary declaring a different isolation is rejected before the savepoint", async () => {
    const { manager, events } = recordingManager({ savepoints: true });
    const interceptor = new TransactionInterceptor(manager);

    const outcome = boundary(interceptor, undefined, () =>
      boundary(
        interceptor,
        { propagation: "NESTED", isolation: "SERIALIZABLE" },
        async () => undefined,
      ),
    );

    await expect(outcome).rejects.toBeInstanceOf(TransactionIsolationOnJoinError);
    expect(ops(events)).toEqual(["begin", "rollback"]);
  });

  test("N3: a REQUIRES_NEW failure rolls back locally while the outer transaction commits", async () => {
    const { manager, events } = recordingManager({ savepoints: true });
    const interceptor = new TransactionInterceptor(manager);

    await boundary(interceptor, undefined, async () => {
      try {
        await boundary(interceptor, { propagation: "REQUIRES_NEW" }, async () => {
          throw new Error("inner failure");
        });
      } catch {
        // 外层显式吞掉内层失败并继续。
      }
      return undefined;
    });

    expect(events).toEqual([
      { op: "begin", resource: "tx1", isolation: undefined },
      { op: "begin", resource: "tx2", isolation: undefined },
      { op: "rollback", resource: "tx2" },
      { op: "commit", resource: "tx1" },
    ]);
  });

  test("N3: an outer failure does not disturb an already committed REQUIRES_NEW transaction", async () => {
    const { manager, events } = recordingManager({ savepoints: true });
    const interceptor = new TransactionInterceptor(manager);

    const outcome = boundary(interceptor, undefined, async () => {
      await boundary(interceptor, { propagation: "REQUIRES_NEW" }, async () => undefined);
      throw new Error("outer failure");
    });

    await expect(outcome).rejects.toThrow("outer failure");
    expect(events).toEqual([
      { op: "begin", resource: "tx1", isolation: undefined },
      { op: "begin", resource: "tx2", isolation: undefined },
      { op: "commit", resource: "tx2" },
      { op: "rollback", resource: "tx1" },
    ]);
  });

  test("N3: a NESTED failure rolls back to the savepoint and the outer transaction can continue", async () => {
    const { manager, events } = recordingManager({ savepoints: true });
    const interceptor = new TransactionInterceptor(manager);

    await boundary(interceptor, undefined, async () => {
      try {
        await boundary(interceptor, { propagation: "NESTED" }, async () => {
          throw new Error("partial failure");
        });
      } catch {
        // 内层已回滚到 savepoint，外层事务存活、继续写入。
      }
      return undefined;
    });

    expect(ops(events)).toEqual(["begin", "savepoint", "rollback-to-savepoint", "commit"]);
  });

  test("N4: any thrown value rolls back the boundary and is rethrown identically", async () => {
    await fc.assert(
      fc.asyncProperty(fc.anything(), async (thrown) => {
        const { manager, events } = recordingManager({ savepoints: true });
        const interceptor = new TransactionInterceptor(manager);
        let caught: unknown = Symbol("untouched");

        try {
          await boundary(interceptor, undefined, async () => {
            throw thrown;
          });
        } catch (error) {
          caught = error;
        }

        expect(Object.is(caught, thrown)).toBe(true);
        expect(ops(events)).toEqual(["begin", "rollback"]);
      }),
    );
  });

  test("N5: an exception swallowed between joined REQUIRED boundaries lets the outer commit", async () => {
    const { manager, events } = recordingManager({ savepoints: true });
    const interceptor = new TransactionInterceptor(manager);

    // 定格 #204 定案 5：加入不是边界、不设 rollback-only——用户 catch 即显式决定继续事务，
    // 不存在 Spring 的 UnexpectedRollbackException。
    await boundary(interceptor, undefined, async () => {
      try {
        await boundary(interceptor, { propagation: "REQUIRED" }, async () => {
          throw new Error("inner failure");
        });
      } catch {
        // 吞掉并继续。
      }
      return undefined;
    });

    expect(ops(events)).toEqual(["begin", "commit"]);
  });

  test("N6: a malformed marker value from an uncompiled caller is rejected before any transaction work", async () => {
    const { manager, events } = recordingManager({ savepoints: true });
    // 方法参数双变：收窄的拦截器可站在宽 ctx 契约后面，正是未经编译的调用方看到的形状。
    const uncompiled: MethodInterceptor = new TransactionInterceptor(manager);

    const outcome = uncompiled.intercept(
      { beanId: "app#Orders", method: "save", args: [], value: { propagation: "MANDATORY" } },
      () => Promise.resolve(undefined),
    );

    await expect(outcome).rejects.toThrow(TypeError);
    expect(events).toEqual([]);
  });

  test("random propagation nesting keeps begin/commit/rollback balanced and restores the scope", async () => {
    const step = fc.record({
      propagation: fc.constantFrom("REQUIRED" as const, "REQUIRES_NEW" as const, "NESTED" as const),
      fails: fc.boolean(),
    });

    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 6 }), async (steps) => {
        const { manager, events } = recordingManager({ savepoints: true });
        const interceptor = new TransactionInterceptor(manager);

        const run = async (index: number): Promise<unknown> => {
          const current = steps[index];
          if (current === undefined) {
            return undefined;
          }
          return boundary(interceptor, { propagation: current.propagation }, async () => {
            try {
              await run(index + 1);
            } catch {
              // 每层都吞掉内层失败：断言只看 manager 协议配对，不看异常路径。
            }
            if (current.fails) {
              throw new Error(`step ${index} failed`);
            }
            return undefined;
          });
        };

        try {
          await run(0);
        } catch {
          // 最外层失败自然穿透。
        }

        const begins = events.filter((event) => event.op === "begin").length;
        const commits = events.filter((event) => event.op === "commit").length;
        const rollbacks = events.filter((event) => event.op === "rollback").length;
        const savepoints = events.filter((event) => event.op === "savepoint").length;
        const releases = events.filter((event) => event.op === "release").length;
        const savepointRollbacks = events.filter(
          (event) => event.op === "rollback-to-savepoint",
        ).length;

        expect(commits + rollbacks).toBe(begins);
        expect(releases + savepointRollbacks).toBe(savepoints);
        expect(activeTransaction()).toBeUndefined();
      }),
    );
  });
});
