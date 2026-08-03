import { describe, expect, test } from "bun:test";
import { hasExactKeys } from "@/project/exact-keys";

const REQUIRED = ["schemaVersion", "mode", "leaseToken"] as const;
const OPTIONAL = ["pid", "note"] as const;

describe("hasExactKeys", () => {
  test("rejects a value that is missing a required key", () => {
    const value = { schemaVersion: 1, mode: "dev" };

    const accepted = hasExactKeys(value, REQUIRED);

    expect(accepted).toBe(false);
  });

  test("rejects a value that carries a key outside the required and optional sets", () => {
    const value = { schemaVersion: 1, mode: "dev", leaseToken: "token", stray: true };

    const accepted = hasExactKeys(value, REQUIRED, OPTIONAL);

    expect(accepted).toBe(false);
  });

  test("rejects a value whose only keys are declared optional ones", () => {
    const value = { pid: 42, note: "restarted" };

    const accepted = hasExactKeys(value, REQUIRED, OPTIONAL);

    expect(accepted).toBe(false);
  });

  test("accepts a value holding exactly the required keys when no optional key is declared", () => {
    const value = { schemaVersion: 1, mode: "dev", leaseToken: "token" };

    const accepted = hasExactKeys(value, REQUIRED);

    expect(accepted).toBe(true);
  });

  test("accepts a value that omits every declared optional key", () => {
    const value = { schemaVersion: 1, mode: "dev", leaseToken: "token" };

    const accepted = hasExactKeys(value, REQUIRED, OPTIONAL);

    expect(accepted).toBe(true);
  });

  test("accepts a value that carries part of the declared optional keys", () => {
    const value = { schemaVersion: 1, mode: "dev", leaseToken: "token", pid: 42 };

    const accepted = hasExactKeys(value, REQUIRED, OPTIONAL);

    expect(accepted).toBe(true);
  });

  test("accepts a value that carries every required and optional key", () => {
    const value = {
      schemaVersion: 1,
      mode: "dev",
      leaseToken: "token",
      pid: 42,
      note: "restarted",
    };

    const accepted = hasExactKeys(value, REQUIRED, OPTIONAL);

    expect(accepted).toBe(true);
  });
});
