import type { Clock } from "@acme/starter-base";
import { defineStarter, Injectable } from "@reforce/core";

export interface CacheConfig {
  prefix(): string;
}

export interface Cache {
  get(key: string): string;
}

@Injectable()
export class MemoryCache implements Cache {
  constructor(
    readonly config: CacheConfig,
    readonly clock: Clock,
  ) {}

  get(key: string): string {
    return `${this.config.prefix()}:${key}:${this.clock.now()}`;
  }
}

@Injectable()
export class CacheMetrics {
  hits(): number {
    return 0;
  }
}

export const cache = defineStarter();
