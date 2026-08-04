export interface Clock {
  now(): number;
}

export declare class SystemClock implements Clock {
  now(): number;
}
