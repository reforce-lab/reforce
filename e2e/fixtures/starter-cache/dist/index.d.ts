import type { Clock } from "@acme/starter-base";

export interface CacheConfig {
  prefix(): string;
}

export interface Cache {
  get(key: string): string;
}

export declare class MemoryCache implements Cache {
  readonly config: CacheConfig;
  readonly clock: Clock;
  constructor(config: CacheConfig, clock: Clock);
  get(key: string): string;
}

export declare class CacheMetrics {
  hits(): number;
}

export declare const cache: import("@reforce/context").StarterDefinition;
