import type { Lazy } from "#internal/public-types";
import type { ReadResolvedTarget } from "#internal/resolution-state";

export function createLazyHandle(readTarget: ReadResolvedTarget): Lazy<object> {
  return Object.freeze({ get: readTarget });
}
