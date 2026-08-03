import type { Lazy } from "@/public-types";
import type { ReadResolvedTarget } from "@/runtime/resolution-state";

export function createLazyHandle(readTarget: ReadResolvedTarget): Lazy<object> {
  return Object.freeze({ get: readTarget });
}
