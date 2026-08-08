import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// 手写 meta 的回读自检（ADR 0004 决策 15 的包内一半）：编译器在应用侧核对 runtimeExport 与
// provides 能否解析，但 `source` span 只有形状校验——行列写漂了不会有任何诊断，explain 与
// 诊断的双侧定位就会指到错误的位置。这里把 span 钉回源码：类挪动而 meta 忘改时本用例先红。

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

interface MetaPosition {
  readonly offset: number;
  readonly line: number;
  readonly character: number;
}

interface MetaBean {
  readonly id: string;
  readonly runtimeExport: { readonly module: string; readonly export: string };
  readonly source: {
    readonly file: string;
    readonly start: MetaPosition;
    readonly end: MetaPosition;
  };
}

async function metaBeans(): Promise<readonly MetaBean[]> {
  const raw = await readFile(path.join(packageRoot, "reforce-meta.json"), "utf8");
  return JSON.parse(raw).beans;
}

function positionAt(text: string, offset: number): { line: number; character: number } {
  const before = text.slice(0, offset);
  const lastBreak = before.lastIndexOf("\n");
  return {
    line: before.split("\n").length - 1,
    character: offset - (lastBreak + 1),
  };
}

describe("reforce-meta source spans", () => {
  test("every bean span starts at its class keyword and ends after its closing brace", async () => {
    for (const bean of await metaBeans()) {
      const text = await readFile(path.join(packageRoot, bean.source.file), "utf8");
      const className = bean.id.split("#")[1] ?? "";

      expect(text.slice(bean.source.start.offset)).toMatch(
        new RegExp(`^class ${className}\\b`, "u"),
      );
      expect(text[bean.source.end.offset - 1]).toBe("}");
    }
  });

  test("line and character agree with the offset they describe", async () => {
    for (const bean of await metaBeans()) {
      const text = await readFile(path.join(packageRoot, bean.source.file), "utf8");

      for (const position of [bean.source.start, bean.source.end]) {
        expect(positionAt(text, position.offset)).toEqual({
          line: position.line,
          character: position.character,
        });
      }
    }
  });

  test("every runtimeExport names a public export of this package's source", async () => {
    const indexText = await readFile(path.join(packageRoot, "src", "index.ts"), "utf8");
    for (const bean of await metaBeans()) {
      expect(bean.runtimeExport.module).toMatch(/^@reforce\/logging(\/|$)/u);
      expect(indexText).toContain(bean.runtimeExport.export);
    }
  });
});
