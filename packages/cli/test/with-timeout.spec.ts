import { expect, test } from "bun:test";
import { withTimeout } from "@/with-timeout";

test("a promise settling inside the budget passes its value through", async () => {
  const settled = Promise.resolve("value");

  const result = await withTimeout(settled, 1_000, "budget exhausted");

  expect(result).toBe("value");
});

test("a promise still pending at the budget rejects with the caller's message", async () => {
  const pending = new Promise<never>(() => {});

  const result = withTimeout(pending, 5, "budget exhausted");

  await expect(result).rejects.toThrow("budget exhausted");
});
