import { Injectable } from "@reforce/context";

export interface Clock {
  now(): number;
}

@Injectable()
export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}
