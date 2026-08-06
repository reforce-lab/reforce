import { defineStarter } from "@reforce/context";

export class SystemClock {
  now() {
    return Date.now();
  }
}

export const clock = defineStarter();
