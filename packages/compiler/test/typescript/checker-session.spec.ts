import { describe, expect, test } from "vitest";
import { CheckerUnavailableError } from "@/typescript/checker-errors";
import {
  type CheckerSession,
  computeFileChanges,
  createCheckerSession,
  type UnstableApiPort,
  type UnstableProjectPort,
  type UnstableSnapshotPort,
} from "@/typescript/checker-session";
import { fakeChecker, fakeProgram, fakeType } from "./support/fake-handles";

// supervisor 状态机(RFC 0012 S1,#273):懒 spawn、崩溃标记与重建、close 幂等。
// 替身理由:边界是 tsgo 子进程的 spawn 与同步 IPC;文件哈希差量的真实盘面行为在
// it/checker-session.spec.ts。

const tsconfigPath = "/app/tsconfig.json";
const file = "/app/src/main.ts";

interface FakeApiLog {
  spawns: number;
  updates: Parameters<UnstableApiPort["updateSnapshot"]>[0][];
  closes: number;
  disposes: number;
}

function fakeApiSession(
  overrides: {
    readonly project?: UnstableProjectPort | undefined;
    readonly updateFailure?: () => Error | undefined;
  } = {},
): { session: CheckerSession; log: FakeApiLog } {
  const log: FakeApiLog = { spawns: 0, updates: [], closes: 0, disposes: 0 };
  const project: UnstableProjectPort = overrides.project ?? {
    checker: fakeChecker({ getTypeAtPosition: () => [fakeType()] }),
    program: fakeProgram({ getSourceFileNames: () => [file] }),
  };
  const session = createCheckerSession({
    spawnApi: () => {
      log.spawns += 1;
      const api: UnstableApiPort = {
        updateSnapshot(params) {
          const failure = overrides.updateFailure?.();
          if (failure !== undefined) {
            throw failure;
          }
          log.updates.push(params);
          const snapshot: UnstableSnapshotPort = {
            getProject: (config) => (config === tsconfigPath ? project : undefined),
            dispose: () => {
              log.disposes += 1;
            },
          };
          return snapshot;
        },
        close() {
          log.closes += 1;
        },
      };
      return api;
    },
  });
  return { session, log };
}

describe("computeFileChanges", () => {
  test("a differing hash lands in changed", () => {
    const changes = computeFileChanges(new Map([["a.ts", "1"]]), new Map([["a.ts", "2"]]));

    expect(changes).toEqual({ changed: ["a.ts"], created: [], deleted: [] });
  });

  test("a new file lands in created and a missing one in deleted", () => {
    const changes = computeFileChanges(new Map([["old.ts", "1"]]), new Map([["new.ts", "1"]]));

    expect(changes).toEqual({ changed: [], created: ["new.ts"], deleted: ["old.ts"] });
  });

  test("identical maps produce no changes", () => {
    const hashes = new Map([["a.ts", "1"]]);

    expect(computeFileChanges(hashes, new Map(hashes))).toEqual({
      changed: [],
      created: [],
      deleted: [],
    });
  });
});

describe("lazy spawn and snapshot reuse", () => {
  test("lease alone spawns nothing", () => {
    const { session, log } = fakeApiSession();

    const lease = session.lease({ tsconfigPath, trackedFiles: [] });
    lease.retire();
    session.close();

    expect(log.spawns).toBe(0);
  });

  test("the first query spawns and opens the project once", () => {
    const { session, log } = fakeApiSession();
    const lease = session.lease({ tsconfigPath, trackedFiles: [] });

    lease.query.getTypesAtPositions(file, [0]);
    lease.query.getTypesAtPositions(file, [1]);

    expect(log.spawns).toBe(1);
    expect(log.updates).toEqual([{ openProjects: [tsconfigPath] }]);
    session.close();
  });

  test("a second lease with unchanged inputs reuses the snapshot without IPC", () => {
    const { session, log } = fakeApiSession();
    const first = session.lease({ tsconfigPath, trackedFiles: [] });
    first.query.getTypesAtPositions(file, [0]);
    first.retire();

    const second = session.lease({ tsconfigPath, trackedFiles: [] });
    second.query.getTypesAtPositions(file, [0]);

    expect(log.updates).toHaveLength(1);
    session.close();
  });
});

describe("crash supervision", () => {
  test("a snapshot failure closes the process and reports unavailability", () => {
    let failing = true;
    const { session, log } = fakeApiSession({
      updateFailure: () => (failing ? new Error("boom") : undefined),
    });
    const lease = session.lease({ tsconfigPath, trackedFiles: [] });

    expect(() => lease.query.getTypesAtPositions(file, [0])).toThrow(CheckerUnavailableError);
    expect(log.closes).toBe(1);

    // 下一个 lease 自动重建:重新 spawn 并重开项目。
    failing = false;
    const next = session.lease({ tsconfigPath, trackedFiles: [] });
    expect(next.query.getTypesAtPositions(file, [0])).toHaveLength(1);
    expect(log.spawns).toBe(2);
    session.close();
  });

  test("a query failure inside the checker marks the session crashed", () => {
    const project: UnstableProjectPort = {
      checker: fakeChecker({
        getTypeAtPosition: () => {
          throw new Error("channel torn");
        },
      }),
      program: fakeProgram({ getSourceFileNames: () => [file] }),
    };
    const { session, log } = fakeApiSession({ project });
    const lease = session.lease({ tsconfigPath, trackedFiles: [] });

    expect(() => lease.query.getTypesAtPositions(file, [0])).toThrow(CheckerUnavailableError);
    expect(log.closes).toBe(1);
    session.close();
  });

  test("a project the server does not load reports unavailability", () => {
    const { session } = fakeApiSession();
    const lease = session.lease({ tsconfigPath: "/app/other-tsconfig.json", trackedFiles: [] });

    expect(() => lease.query.getTypesAtPositions(file, [0])).toThrow(CheckerUnavailableError);
    session.close();
  });
});

describe("close", () => {
  test("close disposes the snapshot, closes the process, and stays idempotent", () => {
    const { session, log } = fakeApiSession();
    const lease = session.lease({ tsconfigPath, trackedFiles: [] });
    lease.query.getTypesAtPositions(file, [0]);

    session.close();
    session.close();

    expect(log.disposes).toBe(1);
    expect(log.closes).toBe(1);
  });

  test("queries after close report unavailability", () => {
    const { session } = fakeApiSession();
    const lease = session.lease({ tsconfigPath, trackedFiles: [] });
    session.close();

    expect(() => lease.query.getTypesAtPositions(file, [0])).toThrow(CheckerUnavailableError);
  });
});
