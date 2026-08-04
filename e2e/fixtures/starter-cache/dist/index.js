export class MemoryCache {
  constructor(config, clock) {
    this.config = config;
    this.clock = clock;
  }

  get(key) {
    return `${this.config.prefix()}:${key}:${this.clock.now()}`;
  }
}

export class CacheMetrics {
  hits() {
    return 0;
  }
}
