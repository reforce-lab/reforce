import { describe, expect, test } from "vitest";
import {
  parseRenderMode,
  type RenderAudience,
  type RenderMode,
  renderModeEnvironmentVariable,
  resolveRenderMode,
} from "@/render-mode";

interface Case {
  readonly name: string;
  readonly explicit?: RenderMode;
  readonly interactive: boolean;
  readonly audience: RenderAudience;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly expected: RenderMode;
}

// 四个维度的优先级是 D1 的全部内容：explicit > env > TTY > audience 缺省。逐条列出来比
// 分散在几个 test 里更容易看出哪一格没覆盖。
const cases: readonly Case[] = [
  {
    name: "explicit wins over everything else",
    explicit: "json",
    interactive: true,
    audience: "tool",
    env: { [renderModeEnvironmentVariable]: "short" },
    expected: "json",
  },
  {
    name: "environment wins over TTY detection",
    interactive: true,
    audience: "tool",
    env: { [renderModeEnvironmentVariable]: "short" },
    expected: "short",
  },
  {
    name: "an unrecognised environment value falls back to detection",
    interactive: true,
    audience: "tool",
    env: { [renderModeEnvironmentVariable]: "pretty" },
    expected: "human",
  },
  {
    name: "a TTY renders for humans regardless of audience",
    interactive: true,
    audience: "application",
    env: {},
    expected: "human",
  },
  {
    name: "a piped tool stays greppable",
    interactive: false,
    audience: "tool",
    env: {},
    expected: "short",
  },
  {
    name: "a piped application emits structured records",
    interactive: false,
    audience: "application",
    env: {},
    expected: "json",
  },
];

describe("render mode resolution", () => {
  test.for(cases)("$name", ({ expected, ...input }) => {
    expect(resolveRenderMode(input)).toBe(expected);
  });
});

describe("render mode parsing", () => {
  test("accepts every published mode name", () => {
    expect([parseRenderMode("human"), parseRenderMode("short"), parseRenderMode("json")]).toEqual([
      "human",
      "short",
      "json",
    ]);
  });

  test("rejects an unknown name instead of guessing", () => {
    expect(parseRenderMode("pretty")).toBeUndefined();
  });

  test("treats an absent value as unset", () => {
    expect(parseRenderMode(undefined)).toBeUndefined();
  });
});
