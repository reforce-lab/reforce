import { expect } from "bun:test";
import { ApplicationCleanupError, ApplicationStartError } from "@/index";

// `expect(...).rejects` 只能断言「拒绝了」，拿不到 reason 本身。这些用例要继续检查 reason 的
// cause、message 和聚合的子错误，所以先把 rejection 取出来再断言（Issue #35）。
export async function rejection(promise: Promise<unknown>): Promise<Error> {
  let reason: unknown;
  try {
    await promise;
  } catch (error) {
    reason = error;
  }
  if (!(reason instanceof Error)) {
    throw new Error("Expected the Promise to reject with an Error.");
  }
  return reason;
}

export function applicationStartError(error: Error): ApplicationStartError {
  expect(error).toBeInstanceOf(ApplicationStartError);
  if (!(error instanceof ApplicationStartError)) {
    throw error;
  }
  return error;
}

export function applicationCleanupError(error: Error): ApplicationCleanupError {
  expect(error).toBeInstanceOf(ApplicationCleanupError);
  if (!(error instanceof ApplicationCleanupError)) {
    throw error;
  }
  return error;
}
