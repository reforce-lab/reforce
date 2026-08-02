import { describe, expect, test } from "bun:test";
import {
  publishMissingDestinationWithWindowsRetry,
  renameWithWindowsRetry,
} from "./windows-rename-retry";

function filesystemError(code: string): Error & { readonly code: string } {
  return Object.assign(new Error(code), { code });
}

describe("Windows rename retry", () => {
  test("retries transient rename failures in bounded delay order", async () => {
    const attempts: string[] = [];
    const delays: number[] = [];
    const failures = [filesystemError("EPERM"), filesystemError("EBUSY")];

    await renameWithWindowsRetry("source", "destination", {
      rename: async (source, destination) => {
        attempts.push(`${source}:${destination}`);
        const failure = failures.shift();
        if (failure !== undefined) {
          throw failure;
        }
      },
      wait: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    expect(attempts).toEqual(["source:destination", "source:destination", "source:destination"]);
    expect(delays).toEqual([10, 20]);
  });

  test("retries a transient gate publish failure only while the destination is absent", async () => {
    const failures = [filesystemError("EPERM"), filesystemError("EBUSY")];
    const delays: number[] = [];
    let attempts = 0;
    let existenceChecks = 0;

    const published = await publishMissingDestinationWithWindowsRetry("staging", "gate", {
      rename: async () => {
        attempts += 1;
        const failure = failures.shift();
        if (failure !== undefined) {
          throw failure;
        }
      },
      destinationExists: async () => {
        existenceChecks += 1;
        return false;
      },
      wait: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    expect(published).toBe(true);
    expect(attempts).toBe(3);
    expect(existenceChecks).toBe(2);
    expect(delays).toEqual([10, 20]);
  });

  test("treats a transient gate publish error as a collision when the destination exists", async () => {
    let attempts = 0;
    const delays: number[] = [];

    const published = await publishMissingDestinationWithWindowsRetry("staging", "gate", {
      rename: async () => {
        attempts += 1;
        throw filesystemError("EPERM");
      },
      destinationExists: async () => true,
      wait: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    expect(published).toBe(false);
    expect(attempts).toBe(1);
    expect(delays).toEqual([]);
  });

  test("stops retrying an absent gate destination after the bounded publish budget", async () => {
    const failure = filesystemError("EBUSY");
    const delays: number[] = [];
    let attempts = 0;

    const result = publishMissingDestinationWithWindowsRetry("staging", "gate", {
      rename: async () => {
        attempts += 1;
        throw failure;
      },
      destinationExists: async () => false,
      wait: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    await expect(result).rejects.toBe(failure);
    expect(attempts).toBe(6);
    expect(delays).toEqual([10, 20, 40, 80, 160]);
  });

  test("reports an existing gate destination as an immediate rename collision", async () => {
    let existenceChecks = 0;

    const published = await publishMissingDestinationWithWindowsRetry("staging", "gate", {
      rename: async () => {
        throw filesystemError("EEXIST");
      },
      destinationExists: async () => {
        existenceChecks += 1;
        return false;
      },
    });

    expect(published).toBe(false);
    expect(existenceChecks).toBe(0);
  });

  test("does not retry a rename failure outside the Windows transient set", async () => {
    const failure = filesystemError("ENOENT");
    let attempts = 0;
    const delays: number[] = [];

    const result = renameWithWindowsRetry("source", "destination", {
      rename: async () => {
        attempts += 1;
        throw failure;
      },
      wait: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    await expect(result).rejects.toBe(failure);
    expect(attempts).toBe(1);
    expect(delays).toEqual([]);
  });

  test("stops after the complete transient retry budget", async () => {
    const failure = filesystemError("ENOTEMPTY");
    let attempts = 0;
    const delays: number[] = [];

    const result = renameWithWindowsRetry("source", "destination", {
      rename: async () => {
        attempts += 1;
        throw failure;
      },
      wait: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    await expect(result).rejects.toBe(failure);
    expect(attempts).toBe(6);
    expect(delays).toEqual([10, 20, 40, 80, 160]);
  });
});
