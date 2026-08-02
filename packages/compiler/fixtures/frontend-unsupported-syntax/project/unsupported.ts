import Alias = require("package-a");

export type Choice<T> = T extends string ? "yes" : "no";
export enum Direction {
  Left,
  Right,
}
export function helper(): void {}

@decorate(factory(), { invalid: true })
export class UnsupportedShapes<T> {
  public constructor(
    union: string | number,
    intersection: Alias & T,
    list: readonly T[],
    tuple: readonly [T, string],
    anonymous: { value: T },
  ) {}

  public ["computed"](value?: T): T | undefined {
    return value;
  }
}

export const unsupportedFactory = defineBean<UnsupportedShapes<string>>({
  create() {
    return new UnsupportedShapes();
  },
  ...extraOptions,
  [dynamicKey]: false,
  unknown: call(),
});
