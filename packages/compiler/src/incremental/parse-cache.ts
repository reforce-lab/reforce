import type { SourceUnit } from "@reforce/compiler-spi";
import { LRUCache } from "lru-cache";

export interface CachedParse {
  readonly unit: SourceUnit;
}

export function createParseCache(): LRUCache<string, CachedParse> {
  return new LRUCache({ max: 512 });
}
