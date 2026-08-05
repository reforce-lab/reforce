import { describe, expect, test } from "vitest";
import { removeWithWindowsRetry } from "@/windows-remove-retry";

function filesystemError(code: string): Error & { readonly code: string } {
  return Object.assign(new Error(code), { code });
}

describe("Windows remove retry", () => {
  test("retries transient removal failures in bounded delay order", async () => {
    const attempts: string[] = [];
    const delays: number[] = [];
    const failures = [filesystemError("EBUSY"), filesystemError("EPERM")];

    await removeWithWindowsRetry("root", {
      remove: async (path) => {
        attempts.push(path);
        const failure = failures.shift();
        if (failure !== undefined) {
          throw failure;
        }
      },
      wait: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    expect(attempts).toEqual(["root", "root", "root"]);
    expect(delays).toEqual([10, 20]);
  });

  test("throws a non-transient error without retrying", async () => {
    let attempts = 0;
    const delays: number[] = [];
    let thrown: unknown;

    try {
      await removeWithWindowsRetry("root", {
        remove: async () => {
          attempts += 1;
          throw filesystemError("EACCES");
        },
        wait: async (milliseconds) => {
          delays.push(milliseconds);
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toEqual(filesystemError("EACCES"));
    expect(attempts).toBe(1);
    expect(delays).toEqual([]);
  });

  test("throws the last transient error after exhausting retries", async () => {
    const errors: Error[] = [];
    const delays: number[] = [];
    let thrown: unknown;

    try {
      await removeWithWindowsRetry("root", {
        remove: async () => {
          const error = filesystemError("EBUSY");
          errors.push(error);
          throw error;
        },
        wait: async (milliseconds) => {
          delays.push(milliseconds);
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(errors).toHaveLength(7);
    expect(thrown).toBe(errors.at(-1));
    expect(delays).toEqual([10, 20, 40, 80, 160, 320]);
  });
});
