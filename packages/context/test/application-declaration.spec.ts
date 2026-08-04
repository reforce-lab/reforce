import { expect, test } from "bun:test";
import { defineApplication, type StarterDefinition } from "@/index";

const starters: readonly StarterDefinition[] = [];

test("defineApplication returns a frozen definition", () => {
  const definition = defineApplication({ starters });

  expect(Object.isFrozen(definition)).toBe(true);
});

test("defineApplication rejects a non-object options value", () => {
  expect(() => defineApplication(JSON.parse("null"))).toThrow(TypeError);
});

test("defineApplication rejects options without a starters array", () => {
  expect(() => defineApplication(JSON.parse("{}"))).toThrow(TypeError);
});
