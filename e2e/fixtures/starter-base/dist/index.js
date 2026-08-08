import { defineStarter } from "@reforce/core";

export class SystemClock {
  now() {
    return Date.now();
  }
}

export const clock = defineStarter();
