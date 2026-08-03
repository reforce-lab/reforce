import { expect, test } from "bun:test";
import { createDevBuildId } from "@/bundling/build-id";

test("a nonempty Rspack hash is the build identity", () => {
  const id = createDevBuildId("abc123");

  expect(id).toBe("rspack:abc123");
});

test("a missing Rspack hash is rejected instead of being replaced by a synthesized identity", () => {
  expect(() => createDevBuildId(undefined)).toThrow(
    "Development build did not produce an Rspack compilation hash.",
  );
});

test("a blank Rspack hash is rejected instead of being replaced by a synthesized identity", () => {
  expect(() => createDevBuildId("   ")).toThrow(
    "Development build did not produce an Rspack compilation hash.",
  );
});
