import fc from "fast-check";
import { describe, expect, test } from "vitest";
import type { ContractTable } from "@/analysis/type-contract";
import { renderResponseEncoder } from "@/emission/render-encoders";
import {
  arrayShape,
  evaluateGenerated,
  literalUnion,
  objectShape,
  referenceShape,
  scalar,
  tableOf,
  unionShape,
} from "./support/generated-code";

// 编码器行为回归(#264 附录实测表,#274 完成判据):白名单投影、bigint/Date 归一、
// 叶子 null/undefined 保留、可选缺不出键、判别联合分派、递归闭合。

type Encoder = (value: unknown) => unknown;

function encoderOf(table: ContractTable): Encoder {
  return evaluateGenerated<Encoder>(renderResponseEncoder("probe", table), "probe");
}

describe("whitelist projection", () => {
  const encoder = encoderOf(
    tableOf(
      objectShape([
        { name: "id", shape: scalar("bigint") },
        { name: "name", shape: scalar("string") },
        { name: "note", shape: scalar("string"), optional: true },
      ]),
    ),
  );

  test("drops keys outside the contract at any depth", () => {
    expect(encoder({ id: 1n, name: "u", secret: "drop me" })).toEqual({ id: "1", name: "u" });
  });

  test("omits absent optional fields but keeps required nulls in place", () => {
    expect(encoder({ id: 1n, name: null })).toEqual({ id: "1", name: null });
    expect(Object.keys(encoder({ id: 1n, name: "u" }) as object)).toEqual(["id", "name"]);
  });
});

describe("scalar normalization", () => {
  test("bigint becomes a decimal string", () => {
    const encoder = encoderOf(tableOf(scalar("bigint")));

    expect(encoder(123n)).toBe("123");
    expect(encoder(-5n)).toBe("-5");
  });

  test("Date positions normalize ISO strings, date strings and epochs alike", () => {
    const encoder = encoderOf(tableOf(scalar("date")));

    expect(encoder(new Date("2026-01-02T03:04:05.000Z"))).toBe("2026-01-02T03:04:05.000Z");
    expect(encoder("2026-01-02")).toBe("2026-01-02T00:00:00.000Z");
    expect(encoder(0)).toBe("1970-01-01T00:00:00.000Z");
  });

  test("an unparseable date passes through untouched", () => {
    const encoder = encoderOf(tableOf(scalar("date")));

    expect(encoder("definitely not a date")).toBe("definitely not a date");
  });

  test("NaN and Infinity numbers are not intercepted", () => {
    const encoder = encoderOf(tableOf(scalar("number")));

    expect(encoder(Number.NaN)).toBeNaN();
    expect(encoder(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
  });

  test("bigint literal unions stringify their bigint members", () => {
    const encoder = encoderOf(tableOf(literalUnion([{ bigint: "10" }, { bigint: "20" }])));

    expect(encoder(10n)).toBe("10");
  });
});

describe("structure encoding", () => {
  test("arrays map their element encoder", () => {
    const encoder = encoderOf(tableOf(arrayShape(scalar("bigint"))));

    expect(encoder([1n, 2n])).toEqual(["1", "2"]);
  });

  test("discriminated unions dispatch on the tag and project the matched member", () => {
    const encoder = encoderOf(
      tableOf(
        unionShape("kind", [
          [
            "circle",
            objectShape([
              { name: "kind", shape: literalUnion(["circle"]) },
              { name: "radius", shape: scalar("number") },
            ]),
          ],
          [
            "square",
            objectShape([
              { name: "kind", shape: literalUnion(["square"]) },
              { name: "side", shape: scalar("number") },
            ]),
          ],
        ]),
      ),
    );

    expect(encoder({ kind: "circle", radius: 2, secret: true })).toEqual({
      kind: "circle",
      radius: 2,
    });
    expect(encoder({ kind: "hexagon" })).toBeUndefined();
  });

  test("recursive definitions close through named helper functions", () => {
    const encoder = encoderOf(
      tableOf(referenceShape("src/contracts.ts#Tree"), {
        "src/contracts.ts#Tree": {
          typeName: "Tree",
          shape: objectShape([
            { name: "children", shape: arrayShape(referenceShape("src/contracts.ts#Tree")) },
            { name: "id", shape: scalar("bigint") },
          ]),
        },
      }),
    );

    expect(encoder({ id: 1n, children: [{ id: 2n, children: [], stray: 1 }] })).toEqual({
      id: "1",
      children: [{ id: "2", children: [] }],
    });
  });

  test("null and undefined leaves pass through at every level", () => {
    const encoder = encoderOf(
      tableOf(
        objectShape([
          { name: "child", shape: objectShape([{ name: "a", shape: scalar("string") }]) },
        ]),
      ),
    );

    expect(encoder({ child: null })).toEqual({ child: null });
    expect(encoder(null)).toBeNull();
  });
});

describe("encode invariants (property-based)", () => {
  const table = tableOf(
    objectShape([
      { name: "id", shape: scalar("bigint") },
      { name: "name", shape: scalar("string") },
      { name: "tags", shape: arrayShape(scalar("string")), optional: true },
    ]),
  );
  const encoder = encoderOf(table);
  const conforming = fc.record({
    id: fc.bigInt(),
    name: fc.string(),
    tags: fc.option(fc.array(fc.string()), { nil: undefined }),
    stray: fc.anything(),
  });

  test("JSON.stringify never throws on the product and no stray key survives", () => {
    fc.assert(
      fc.property(conforming, (value) => {
        const encoded = encoder(value);
        JSON.stringify(encoded);
        const keys = Object.keys(encoded as object);
        return keys.every((key) => key === "id" || key === "name" || key === "tags");
      }),
    );
  });
});
