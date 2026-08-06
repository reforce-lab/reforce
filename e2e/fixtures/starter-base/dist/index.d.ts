export interface Clock {
  now(): number;
}

export declare class SystemClock implements Clock {
  now(): number;
}

export declare const clock: import("@reforce/context").StarterDefinition;
