import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { CheckerUnavailableError, StaleCheckerHandleError } from "@/typescript/checker-errors";
import { type CheckerHarness, createCheckerHarness } from "./support/checker-project";

// checker 会话对真 tsgo 子进程的生命周期契约(RFC 0012 S1,#273):懒 spawn、close、崩溃重建、
// 跨代句柄验籍、fileChanges 增量、UTF-16 offset。

const contractsSource = [
  "// 中文与 emoji 在前,制造 UTF-8/UTF-16 offset 差异:😀 张三",
  "export interface 用户 {",
  "  名字: string;",
  '  emoji: "😀" | "😎";',
  "}",
  "export interface Probe {",
  "  value: string;",
  "}",
  "",
].join("\n");

let harness: CheckerHarness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

// vitest worker 直接持有 tsgo 子进程,linux 下经 /proc 数它的 `tsc` 子进程。
function tsgoChildProcessIds(): readonly number[] {
  const children: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    try {
      const stat = readFileSync(path.join("/proc", entry, "stat"), "utf8");
      const closeParen = stat.lastIndexOf(")");
      const command = stat.slice(stat.indexOf("(") + 1, closeParen);
      const parentId = Number(stat.slice(closeParen + 2).split(" ")[1]);
      if (command === "tsc" && parentId === process.pid) {
        children.push(Number(entry));
      }
    } catch {
      // 进程在扫描间隙退出,跳过。
    }
  }
  return children;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Condition not reached in time");
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
}

describe("UTF-16 positions", () => {
  test("offsets after CJK and emoji text hit the annotated types", async () => {
    harness = await createCheckerHarness({ "contracts.ts": contractsSource });
    const lease = harness.lease();
    const file = harness.filePath("src/contracts.ts");

    const [nameType, emojiType] = lease.query.getTypesAtPositions(file, [
      harness.offsetOf("src/contracts.ts", "名字"),
      harness.offsetOf("src/contracts.ts", "emoji", 1),
    ]);

    expect(nameType === undefined ? undefined : lease.query.intrinsicOf(nameType)).toBe("string");
    const members = emojiType === undefined ? undefined : lease.query.unionMembers(emojiType);
    expect(members?.map((member) => lease.query.literalOf(member))).toEqual([
      { kind: "string", value: "😀" },
      { kind: "string", value: "😎" },
    ]);
  });
});

describe("program membership", () => {
  test("a file the compiler tracks but tsgo does not answers undefined", async () => {
    harness = await createCheckerHarness({ "contracts.ts": contractsSource });
    const lease = harness.lease();

    const answers = lease.query.getTypesAtPositions(harness.filePath("src/missing.ts"), [0, 10]);

    expect(answers).toEqual([undefined, undefined]);
  });
});

describe("incremental snapshots", () => {
  test("a file change is visible at the same position on the next lease", async () => {
    harness = await createCheckerHarness({ "contracts.ts": contractsSource });
    const file = harness.filePath("src/contracts.ts");
    const offset = harness.offsetOf("src/contracts.ts", "value");
    const first = harness.lease();
    const before = first.query.getTypesAtPositions(file, [offset])[0];
    expect(before === undefined ? undefined : first.query.intrinsicOf(before)).toBe("string");
    first.retire();

    // string → number 同长度,offset 保持稳定。
    writeFileSync(file, readFileSync(file, "utf8").replace("value: string", "value: number"));
    const second = harness.lease();
    const after = second.query.getTypesAtPositions(file, [offset])[0];

    expect(after === undefined ? undefined : second.query.intrinsicOf(after)).toBe("number");
  });

  test("a handle from a retired lease is refused by the next one", async () => {
    harness = await createCheckerHarness({ "contracts.ts": contractsSource });
    const file = harness.filePath("src/contracts.ts");
    const offset = harness.offsetOf("src/contracts.ts", "value");
    const first = harness.lease();
    const stale = first.query.getTypesAtPositions(file, [offset])[0];
    if (stale === undefined) {
      throw new Error("expected a type");
    }
    first.retire();

    const second = harness.lease();
    expect(() => second.query.unionMembers(stale)).toThrow(StaleCheckerHandleError);
    expect(() => first.query.intrinsicOf(stale)).toThrow(StaleCheckerHandleError);
  });
});

describe.runIf(process.platform === "linux")("process lifecycle", () => {
  test("the session spawns lazily and close terminates the child idempotently", async () => {
    harness = await createCheckerHarness({ "contracts.ts": contractsSource });
    const before = tsgoChildProcessIds().length;
    const lease = harness.lease();
    expect(tsgoChildProcessIds().length).toBe(before);

    lease.query.getTypesAtPositions(harness.filePath("src/contracts.ts"), [0]);
    expect(tsgoChildProcessIds().length).toBe(before + 1);

    harness.session.close();
    harness.session.close();
    await waitFor(() => tsgoChildProcessIds().length === before);

    expect(() =>
      lease.query.getTypesAtPositions(harness?.filePath("src/contracts.ts") ?? "", [0]),
    ).toThrow(CheckerUnavailableError);
  });

  test("a killed subprocess fails the current query and the next lease rebuilds", async () => {
    harness = await createCheckerHarness({ "contracts.ts": contractsSource });
    const file = harness.filePath("src/contracts.ts");
    const offset = harness.offsetOf("src/contracts.ts", "value");
    const known = new Set(tsgoChildProcessIds());
    const first = harness.lease();
    first.query.getTypesAtPositions(file, [offset]);
    const spawned = tsgoChildProcessIds().filter((processId) => !known.has(processId));
    expect(spawned).toHaveLength(1);
    const childId = spawned[0];
    if (childId === undefined) {
      throw new Error("expected a tsgo child");
    }

    process.kill(childId, "SIGKILL");
    await waitFor(() => {
      try {
        process.kill(childId, 0);
        return false;
      } catch {
        return true;
      }
    });

    expect(() => first.query.getTypesAtPositions(file, [offset])).toThrow(CheckerUnavailableError);

    const second = harness.lease();
    const recovered = second.query.getTypesAtPositions(file, [offset])[0];
    expect(recovered === undefined ? undefined : second.query.intrinsicOf(recovered)).toBe(
      "string",
    );
  });
});
