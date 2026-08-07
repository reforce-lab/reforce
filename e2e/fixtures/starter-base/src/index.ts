import { defineStarter, Injectable } from "@reforce/core";

export interface Clock {
  now(): number;
}

@Injectable()
export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

export const clock = defineStarter();
