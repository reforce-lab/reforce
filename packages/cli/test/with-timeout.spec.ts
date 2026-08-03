import { expect, test } from "bun:test";
import { withTimeout } from "@/with-timeout";

test("a promise settling inside the budget passes its value through", async () => {
  const settled = Promise.resolve("value");

  const result = await withTimeout(settled, 1_000, "budget exhausted");

  expect(result).toBe("value");
});

test("a promise still pending at the budget rejects with the caller's message", async () => {
  // withTimeout unrefs its timer, so it cannot hold the event loop on its own — every production
  // call site is awaiting a live child process that does. That precondition has to be reproduced
  // here: on Windows a Bun timer that is unref'd and is the only pending work never fires, and the
  // await below then hangs forever (Issue #77). POSIX fires it either way, which is why this only
  // showed up on the windows-latest runner.
  const keepEventLoopAlive = setInterval(() => {}, 1_000);
  const pending = new Promise<never>(() => {});

  try {
    const result = withTimeout(pending, 5, "budget exhausted");

    await expect(result).rejects.toThrow("budget exhausted");
  } finally {
    clearInterval(keepEventLoopAlive);
  }
});
