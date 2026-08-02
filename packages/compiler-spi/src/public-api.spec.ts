import { expect, test } from "bun:test";
import * as compilerSpi from "./index";

test("exposes a type-only runtime surface", () => {
  const runtimeExports = Object.keys(compilerSpi);

  expect(runtimeExports).toEqual([]);
});
