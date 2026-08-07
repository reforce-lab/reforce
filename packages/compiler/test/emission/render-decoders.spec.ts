import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { renderBodyDecoder, renderStringSlotDecoder } from "@/emission/render-decoders";
import {
  arrayShape,
  bodySlot,
  decodedValue,
  decodeIssues,
  type EvaluatedDecoder,
  evaluateGenerated,
  literalUnion,
  objectShape,
  referenceShape,
  scalar,
  stringSlot,
  tableOf,
  unionShape,
  validateWith,
} from "./support/generated-code";

// 解码器行为回归(#264 附录实测表逐条,#274 完成判据):生成源码剥类型后真实执行。

function textDecoder(
  kind: "param" | "query" | "header",
  form: "single" | "optional-single" | "contract",
  key: string | undefined,
  table: Parameters<typeof stringSlot>[0]["table"],
): EvaluatedDecoder {
  const slot = stringSlot({ kind, form, ...(key === undefined ? {} : { key }), table });
  return evaluateGenerated(renderStringSlotDecoder("probe", slot), "probe");
}

describe("param single-key decoding", () => {
  const bigintDecoder = textDecoder("param", "single", "id", tableOf(scalar("bigint")));

  test("decodes a digit string into a bigint", () => {
    expect(decodedValue(bigintDecoder, { id: "123" })).toBe(123n);
    expect(decodedValue(bigintDecoder, { id: "-5" })).toBe(-5n);
  });

  test("pre-checks the bigint grammar instead of calling BigInt blindly", () => {
    expect(decodeIssues(bigintDecoder, { id: "1.5" })).toEqual(["id must be an integer"]);
    expect(decodeIssues(bigintDecoder, { id: "12abc" })).toEqual(["id must be an integer"]);
  });

  test("reports a missing required key", () => {
    expect(decodeIssues(bigintDecoder, {})).toEqual(["id must be present"]);
  });
});

describe("number text grammar", () => {
  const decoder = textDecoder("query", "single", "page", tableOf(scalar("number")));
  const carrier = (value: string) => new URLSearchParams([["page", value]]);

  test("accepts scientific notation and trims whitespace", () => {
    expect(decodedValue(decoder, carrier("1e3"))).toBe(1000);
    expect(decodedValue(decoder, carrier(" 42 "))).toBe(42);
    expect(decodedValue(decoder, carrier("1.5"))).toBe(1.5);
    expect(decodedValue(decoder, carrier("-0.5"))).toBe(-0.5);
  });

  test("rejects empty, blank, hex and Infinity forms that Number() would accept", () => {
    for (const raw of ["", "   ", "0x10", "Infinity", "-Infinity", "NaN", "12px"]) {
      expect(decodeIssues(decoder, carrier(raw))).toEqual(["page must be a number"]);
    }
  });
});

describe("boolean and date text decoding", () => {
  const booleanDecoder = textDecoder("query", "single", "on", tableOf(scalar("boolean")));
  const dateDecoder = textDecoder("query", "single", "from", tableOf(scalar("date")));

  test('accepts only "true" and "false"', () => {
    expect(decodedValue(booleanDecoder, new URLSearchParams([["on", "true"]]))).toBe(true);
    expect(decodedValue(booleanDecoder, new URLSearchParams([["on", "false"]]))).toBe(false);
    for (const raw of ["True", "1", "yes", ""]) {
      expect(decodeIssues(booleanDecoder, new URLSearchParams([["on", raw]]))).toEqual([
        'on must be "true" or "false"',
      ]);
    }
  });

  test("parses dates and rejects unparseable text", () => {
    const decoded = decodedValue(dateDecoder, new URLSearchParams([["from", "2026-01-02"]]));
    expect(decoded).toBeInstanceOf(Date);
    expect((decoded as Date).toISOString()).toBe("2026-01-02T00:00:00.000Z");
    expect(decodeIssues(dateDecoder, new URLSearchParams([["from", "not a date"]]))).toEqual([
      "from must be a date",
    ]);
  });
});

describe("literal union text decoding", () => {
  const decoder = textDecoder("query", "single", "sort", tableOf(literalUnion(["asc", "desc"])));

  test("accepts members and rejects strangers with the allowed list", () => {
    expect(decodedValue(decoder, new URLSearchParams([["sort", "asc"]]))).toBe("asc");
    expect(decodeIssues(decoder, new URLSearchParams([["sort", "up"]]))).toEqual([
      "sort must be one of: asc, desc",
    ]);
  });
});

describe("optional single keys", () => {
  const decoder = textDecoder("header", "optional-single", "x-tenant", tableOf(scalar("string")));

  test("decodes a missing optional key to undefined instead of an issue", () => {
    expect(decodedValue(decoder, new Headers())).toBeUndefined();
    expect(decodedValue(decoder, new Headers([["x-tenant", "acme"]]))).toBe("acme");
  });
});

describe("carriers", () => {
  test("header lookups are case-insensitive because the carrier is a native Headers", () => {
    const decoder = textDecoder("header", "single", "x-tenant-id", tableOf(scalar("string")));

    expect(decodedValue(decoder, new Headers([["X-Tenant-Id", "acme"]]))).toBe("acme");
  });

  test("query scalars take the first value, arrays take getAll", () => {
    const scalarDecoder = textDecoder("query", "single", "page", tableOf(scalar("string")));
    const arrayDecoder = textDecoder(
      "query",
      "single",
      "tag",
      tableOf(arrayShape(scalar("string"))),
    );
    const carrier = new URLSearchParams([
      ["page", "1"],
      ["page", "2"],
      ["tag", "a"],
      ["tag", "b"],
    ]);

    expect(decodedValue(scalarDecoder, carrier)).toBe("1");
    expect(decodedValue(arrayDecoder, carrier)).toEqual(["a", "b"]);
  });

  test("a missing query array key decodes to an empty array (getAll semantics)", () => {
    const decoder = textDecoder("query", "single", "tag", tableOf(arrayShape(scalar("number"))));

    expect(decodedValue(decoder, new URLSearchParams())).toEqual([]);
    expect(decodeIssues(decoder, new URLSearchParams([["tag", "x"]]))).toEqual([
      "tag must be a number",
    ]);
  });
});

describe("string-slot contract decoding", () => {
  const table = tableOf(
    objectShape([
      { name: "id", shape: scalar("bigint") },
      { name: "orgId", shape: scalar("bigint") },
      { name: "trace", shape: scalar("string"), optional: true },
    ]),
  );
  const decoder = textDecoder("param", "contract", undefined, table);

  test("decodes declared fields and ignores undeclared keys", () => {
    expect(decodedValue(decoder, { id: "1", orgId: "2", extra: "ignored" })).toEqual({
      id: 1n,
      orgId: 2n,
    });
  });

  test("collects issues across fields in one pass", () => {
    expect(decodeIssues(decoder, { id: "abc" })).toEqual([
      "id must be an integer",
      "orgId must be present",
    ]);
  });

  test("issues carry the field path in contract form", () => {
    const result = validateWith(decoder, {});
    expect("issues" in result ? result.issues?.map((issue) => issue.path) : []).toEqual([
      ["id"],
      ["orgId"],
    ]);
  });
});

describe("body decoding layers", () => {
  const userTable = tableOf(
    objectShape([
      { name: "age", shape: scalar("number") },
      { name: "id", shape: scalar("bigint") },
      { name: "name", shape: scalar("string") },
      { name: "note", shape: scalar("string"), optional: true },
    ]),
  );
  const decoder = evaluateGenerated<EvaluatedDecoder>(
    renderBodyDecoder("probe", bodySlot(userTable)),
    "probe",
  );

  test("rejects a non-object payload for an object root (定形)", () => {
    expect(decodeIssues(decoder, "not an object")).toEqual(["value must be an object"]);
    expect(decodeIssues(decoder, [1, 2])).toEqual(["value must be an object"]);
    expect(decodeIssues(decoder, null)).toEqual(["value must be an object"]);
  });

  test("decodes fields, drops extras, keeps optional absent", () => {
    expect(decodedValue(decoder, { age: 30, id: 7, name: "u", extra: true })).toEqual({
      age: 30,
      id: 7n,
      name: "u",
    });
  });

  test("bigint number positions require integers (Number.isInteger, not isSafeInteger)", () => {
    // 2^54 超出 safe integer 但可被双精度精确表示:isSafeInteger 会拒,isInteger 收。
    expect(decodedValue(decoder, { age: 1, id: 2 ** 54, name: "u" })).toMatchObject({
      id: BigInt(2 ** 54),
    });
    expect(decodeIssues(decoder, { age: 1, id: 1.5, name: "u" })).toEqual([
      "id must be an integer",
    ]);
  });

  test("bigint string positions run the same grammar precheck", () => {
    expect(decodedValue(decoder, { age: 1, id: "12", name: "u" })).toMatchObject({ id: 12n });
    expect(decodeIssues(decoder, { age: 1, id: "1.2", name: "u" })).toEqual([
      "id must be an integer",
    ]);
  });

  test("reports nested paths for missing and mistyped fields", () => {
    const result = validateWith(decoder, { age: "x", name: 42 });
    const issues = "issues" in result && result.issues !== undefined ? result.issues : [];
    expect(issues.map((issue) => [issue.message, issue.path])).toEqual([
      ["age must be a number", ["age"]],
      ["id must be present", ["id"]],
      ["name must be a string", ["name"]],
    ]);
  });

  test("accepts scalar and array roots (Body 三种定形)", () => {
    const scalarDecoder = evaluateGenerated<EvaluatedDecoder>(
      renderBodyDecoder("probe", bodySlot(tableOf(literalUnion(["ok"])))),
      "probe",
    );
    const arrayDecoder = evaluateGenerated<EvaluatedDecoder>(
      renderBodyDecoder("probe", bodySlot(tableOf(arrayShape(scalar("number"))))),
      "probe",
    );

    expect(decodedValue(scalarDecoder, "ok")).toBe("ok");
    expect(decodeIssues(scalarDecoder, "nope")).toEqual(["value must be one of: ok"]);
    expect(decodedValue(arrayDecoder, [1, 2.5])).toEqual([1, 2.5]);
    expect(decodeIssues(arrayDecoder, [1, "x"]).at(0)).toBe("1 must be a number");
  });

  test("decodes discriminated unions by tag and rejects unknown tags", () => {
    const shapeTable = tableOf(
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
    );
    const unionDecoder = evaluateGenerated<EvaluatedDecoder>(
      renderBodyDecoder("probe", bodySlot(shapeTable)),
      "probe",
    );

    expect(decodedValue(unionDecoder, { kind: "circle", radius: 2 })).toEqual({
      kind: "circle",
      radius: 2,
    });
    expect(decodeIssues(unionDecoder, { kind: "hexagon" })).toEqual([
      "kind must be one of: circle, square",
    ]);
  });

  test("closes recursive contracts through definition functions", () => {
    const treeTable = tableOf(referenceShape("src/contracts.ts#Tree"), {
      "src/contracts.ts#Tree": {
        typeName: "Tree",
        shape: objectShape([
          { name: "children", shape: arrayShape(referenceShape("src/contracts.ts#Tree")) },
          { name: "label", shape: scalar("string") },
        ]),
      },
    });
    const treeDecoder = evaluateGenerated<EvaluatedDecoder>(
      renderBodyDecoder("probe", bodySlot(treeTable)),
      "probe",
    );

    expect(
      decodedValue(treeDecoder, { label: "root", children: [{ label: "leaf", children: [] }] }),
    ).toEqual({ label: "root", children: [{ label: "leaf", children: [] }] });
    expect(
      decodeIssues(treeDecoder, { label: "root", children: [{ label: 1, children: [] }] }),
    ).toEqual(["children.0.label must be a string"]);
  });

  test("honours nullable positions without loosening non-nullable ones", () => {
    const nullableTable = tableOf(objectShape([{ name: "note", shape: scalar("string", true) }]));
    const nullableDecoder = evaluateGenerated<EvaluatedDecoder>(
      renderBodyDecoder("probe", bodySlot(nullableTable)),
      "probe",
    );

    expect(decodedValue(nullableDecoder, { note: null })).toEqual({ note: null });
    expect(decodeIssues(decoder, { age: 1, id: 2, name: null })).toEqual(["name must be a string"]);
  });
});

describe("decode invariants (property-based)", () => {
  test("a single-key number decode either yields a number or reports issues", () => {
    const decoder = textDecoder("query", "single", "n", tableOf(scalar("number")));
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const result = validateWith(decoder, new URLSearchParams([["n", raw]]));
        if ("issues" in result && result.issues !== undefined) {
          return result.issues.length > 0;
        }
        const value = (result as { value: unknown }).value;
        return typeof value === "number" && Number.isFinite(value);
      }),
    );
  });

  test("body object decode products only ever carry declared keys", () => {
    const decoder = evaluateGenerated<EvaluatedDecoder>(
      renderBodyDecoder(
        "probe",
        bodySlot(
          tableOf(
            objectShape([
              { name: "a", shape: scalar("string"), optional: true },
              { name: "b", shape: scalar("number"), optional: true },
            ]),
          ),
        ),
      ),
      "probe",
    );
    fc.assert(
      fc.property(fc.object(), (raw) => {
        const result = validateWith(decoder, raw);
        if ("issues" in result && result.issues !== undefined) {
          return result.issues.length > 0;
        }
        const value = (result as { value: unknown }).value as Record<string, unknown>;
        return Object.keys(value).every((key) => key === "a" || key === "b");
      }),
    );
  });
});
