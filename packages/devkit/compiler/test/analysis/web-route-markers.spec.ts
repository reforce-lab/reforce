import { describe, expect, test } from "vitest";
import { metaValueOf } from "@/analysis/web-route-markers";
import type { CompilerDiagnostic } from "@/api";
import type { DecoratorArgumentValue, ObjectLiteralProperty } from "@/parser/source-ir";
import { span } from "./support/ir";

// marker 值的字面量提取（ADR 0006 W3）此前只有 it/ 层护栏。数值有限性、嵌套形态与不支持的
// 属性形态这些分支不依赖 linker，直接喂 IR 就能钉住（#363）。

const anchor = span("src/markers.ts");

function collect(): CompilerDiagnostic[] {
  return [];
}

function codes(diagnostics: readonly CompilerDiagnostic[]): readonly string[] {
  return diagnostics.map((item) => item.code);
}

function property(key: string, value: DecoratorArgumentValue): ObjectLiteralProperty {
  return { kind: "property", key, value, span: anchor };
}

const stringLiteral: DecoratorArgumentValue = {
  kind: "string-literal",
  value: "public",
  span: anchor,
};
const booleanLiteral: DecoratorArgumentValue = {
  kind: "boolean-literal",
  value: true,
  span: anchor,
};
const numberLiteral: DecoratorArgumentValue = { kind: "number-literal", value: 42, span: anchor };
const nullLiteral: DecoratorArgumentValue = { kind: "null-literal", span: anchor };

describe("metaValueOf", () => {
  test.each([
    ["string", stringLiteral, "public"],
    ["boolean", booleanLiteral, true],
    ["number", numberLiteral, 42],
    ["null", nullLiteral, null],
  ] as const)("lowers a %s literal to its JSON value", (_kind, literal, expected) => {
    const diagnostics = collect();

    const value = metaValueOf(literal, diagnostics);

    expect(value).toEqual(expected);
    expect(diagnostics).toEqual([]);
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects the non-finite number %p because the route table has to serialize it",
    (value) => {
      const diagnostics = collect();

      const lowered = metaValueOf({ kind: "number-literal", value, span: anchor }, diagnostics);

      expect(lowered).toBeUndefined();
      expect(codes(diagnostics)).toEqual(["INVALID_ROUTE_MARKER_VALUE"]);
    },
  );

  test("lowers an array literal element by element", () => {
    const diagnostics = collect();

    const value = metaValueOf(
      {
        kind: "array-literal",
        elements: [stringLiteral, numberLiteral],
        span: anchor,
      },
      diagnostics,
    );

    expect(value).toEqual(["public", 42]);
  });

  test("abandons the whole array when one element is not extractable", () => {
    const diagnostics = collect();

    const value = metaValueOf(
      {
        kind: "array-literal",
        elements: [stringLiteral, { kind: "number-literal", value: Number.NaN, span: anchor }],
        span: anchor,
      },
      diagnostics,
    );

    expect(value).toBeUndefined();
  });

  test("lowers nested object and array literals into a plain JSON tree", () => {
    const diagnostics = collect();

    const value = metaValueOf(
      {
        kind: "object-literal",
        properties: [
          property("scope", stringLiteral),
          property("audit", booleanLiteral),
          property("tags", {
            kind: "array-literal",
            elements: [{ kind: "string-literal", value: "a", span: anchor }],
            span: anchor,
          }),
        ],
        span: anchor,
      },
      diagnostics,
    );

    expect(value).toEqual({ scope: "public", audit: true, tags: ["a"] });
    expect(diagnostics).toEqual([]);
  });

  test.each(["computed", "method", "spread"] as const)(
    "rejects a %s property by name instead of silently dropping it",
    (propertyKind) => {
      const diagnostics = collect();

      const value = metaValueOf(
        {
          kind: "object-literal",
          properties: [{ kind: "unsupported-property", propertyKind, span: anchor }],
          span: anchor,
        },
        diagnostics,
      );

      expect(value).toBeUndefined();
      expect(diagnostics[0]?.message).toContain(propertyKind);
    },
  );

  test("rejects an identifier reference: marker values must be statically extractable", () => {
    const diagnostics = collect();

    const value = metaValueOf(
      {
        kind: "identifier-reference",
        entity: { kind: "identifier", name: "SHARED", span: anchor },
        span: anchor,
      },
      diagnostics,
    );

    expect(value).toBeUndefined();
    expect(codes(diagnostics)).toEqual(["INVALID_ROUTE_MARKER_VALUE"]);
  });

  test("reports the innermost offending value rather than the enclosing object", () => {
    const diagnostics = collect();
    const inner = span("src/markers.ts", 7);

    metaValueOf(
      {
        kind: "object-literal",
        properties: [
          property("nested", {
            kind: "identifier-reference",
            entity: { kind: "identifier", name: "SHARED", span: inner },
            span: inner,
          }),
        ],
        span: anchor,
      },
      diagnostics,
    );

    expect(diagnostics[0]?.sourceSpan).toEqual(inner);
  });
});
