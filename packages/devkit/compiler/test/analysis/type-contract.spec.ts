import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  type ContractShape,
  type ContractTable,
  expandTypeContract,
  type TypeContractResult,
} from "@/analysis/type-contract";
import type { CanonicalFileId, SourceSpan } from "@/parser/source-location";
import {
  anonymousObject,
  array,
  createStubQuery,
  dateType,
  intrinsic,
  literal,
  namedObject,
  projectNamed,
  property,
  type StubType,
  stringLiteral,
  union,
} from "./support/type-contract-stub";

// 类型→字段表算法(RFC 0012 S1,#273)。全部分支在内存类型图上钉住;真 checker 的语义对照
// (工具类型、enum、Date 双声明等 stub 表达不了的部分)在 it/type-contract.spec.ts。

function span(): SourceSpan {
  return {
    fileId: "src/contracts.ts" as CanonicalFileId, // justified: 测试构造的相对路径满足 canonical 文法
    start: { offset: 10, line: 1, character: 0 },
    end: { offset: 20, line: 1, character: 10 },
  };
}

function expand(type: StubType): TypeContractResult {
  return expandTypeContract({
    type,
    span: span(),
    query: createStubQuery(),
    fileIdOf: (path) => (path.startsWith("/app/") ? path.slice("/app/".length) : undefined),
  });
}

function tableOf(type: StubType): ContractTable {
  const result = expand(type);
  expect(result.diagnostics).toEqual([]);
  if (result.table === undefined) {
    throw new Error("Expected a contract table");
  }
  return result.table;
}

function codesOf(result: TypeContractResult): readonly string[] {
  return result.diagnostics.map((item) => item.code);
}

describe("contract closed set violations", () => {
  test("a symbol-typed field is rejected", () => {
    const result = expand(anonymousObject([property("token", intrinsic("symbol"))]));

    expect(result.table).toBeUndefined();
    expect(codesOf(result)).toEqual(["INVALID_CONTRACT_TYPE"]);
    expect(result.diagnostics[0]?.message).toContain("`token`");
  });

  test("a callable field is rejected", () => {
    const callable: StubType = { kind: "object", properties: [], callable: true };

    const result = expand(anonymousObject([property("onDone", callable)]));

    expect(result.table).toBeUndefined();
    expect(codesOf(result)).toEqual(["INVALID_CONTRACT_TYPE"]);
  });

  test("a built-in container other than Date is rejected", () => {
    const setLike: StubType = {
      kind: "object",
      properties: [],
      named: { name: "Set", declarationPath: "/lib/lib.es2015.collection.d.ts" },
      defaultLib: true,
    };

    const result = expand(anonymousObject([property("ids", setLike)]));

    expect(result.table).toBeUndefined();
    expect(codesOf(result)).toEqual(["INVALID_CONTRACT_TYPE"]);
    expect(result.diagnostics[0]?.message).toContain("built-in");
  });

  test.each([
    ["tuple", { kind: "tuple" } as StubType],
    ["template literal", { kind: "template" } as StubType],
    ["any", intrinsic("any")],
    ["unknown", intrinsic("unknown")],
    ["never", intrinsic("never")],
    ["void", intrinsic("void")],
  ])("%s is rejected", (_label, type) => {
    const result = expand(anonymousObject([property("field", type)]));

    expect(result.table).toBeUndefined();
    expect(codesOf(result)).toEqual(["INVALID_CONTRACT_TYPE"]);
  });

  test("a bare scalar union is rejected", () => {
    const result = expand(
      anonymousObject([property("id", union([intrinsic("string"), intrinsic("number")]))]),
    );

    expect(result.table).toBeUndefined();
    expect(codesOf(result)).toEqual(["INVALID_CONTRACT_TYPE"]);
  });

  test("a union mixing scalars and objects is rejected", () => {
    const result = expand(
      anonymousObject([property("value", union([intrinsic("string"), anonymousObject([])]))]),
    );

    expect(result.table).toBeUndefined();
    expect(codesOf(result)).toEqual(["INVALID_CONTRACT_TYPE"]);
  });

  test("undefined in an array element position is rejected", () => {
    const result = expand(
      anonymousObject([
        property("items", array(union([intrinsic("string"), intrinsic("undefined")]))),
      ]),
    );

    expect(result.table).toBeUndefined();
    expect(codesOf(result)).toEqual(["INVALID_CONTRACT_TYPE"]);
    expect(result.diagnostics[0]?.message).toContain("items[]");
  });

  test("a branded primitive intersection is rejected", () => {
    const branded: StubType = {
      kind: "intersection",
      members: [intrinsic("string"), anonymousObject([])],
      properties: [],
    };

    const result = expand(anonymousObject([property("userId", branded)]));

    expect(result.table).toBeUndefined();
    expect(codesOf(result)).toEqual(["INVALID_CONTRACT_TYPE"]);
    expect(result.diagnostics[0]?.message).toContain("intersection");
  });

  test("a class contract is rejected with interface guidance", () => {
    const classType: StubType = {
      kind: "object",
      properties: [property("name", intrinsic("string"))],
      named: projectNamed("UserEntity"),
      isClass: true,
    };

    const result = expand(classType);

    expect(result.table).toBeUndefined();
    expect(codesOf(result)).toEqual(["CONTRACT_CLASS_TYPE"]);
    expect(result.diagnostics[0]?.help).toContain("interface");
  });

  test("an index signature is rejected", () => {
    const record: StubType = { kind: "object", properties: [], indexSignature: true };

    const result = expand(anonymousObject([property("extra", record)]));

    expect(result.table).toBeUndefined();
    expect(codesOf(result)).toEqual(["CONTRACT_INDEX_SIGNATURE"]);
  });

  test("an index signature contributed by an intersection member is rejected", () => {
    const merged: StubType = {
      kind: "intersection",
      members: [anonymousObject([]), anonymousObject([])],
      properties: [property("x", intrinsic("string"))],
      indexSignature: true,
    };

    const result = expand(anonymousObject([property("inter", merged)]));

    expect(result.table).toBeUndefined();
    expect(codesOf(result)).toEqual(["CONTRACT_INDEX_SIGNATURE"]);
  });

  test("an external recursive cycle with no promotable type is rejected", () => {
    const external: StubType & { kind: "object" } = {
      kind: "object",
      properties: [],
      named: { name: "ExternalNode", declarationPath: "/node_modules/pkg/index.d.ts" },
    };
    external.properties = [property("next", external)];

    const result = expand(anonymousObject([property("root", external)]));

    expect(result.table).toBeUndefined();
    expect(codesOf(result)).toEqual(["INVALID_CONTRACT_TYPE"]);
    expect(result.diagnostics[0]?.message).toContain("no promotable named type");
  });

  test("every violation is reported in one pass", () => {
    const result = expand(
      anonymousObject([
        property("callback", { kind: "object", properties: [], callable: true }),
        property("tags", { kind: "object", properties: [], indexSignature: true }),
      ]),
    );

    expect(result.table).toBeUndefined();
    expect(codesOf(result)).toEqual(["INVALID_CONTRACT_TYPE", "CONTRACT_INDEX_SIGNATURE"]);
  });

  test("diagnostics follow the sorted field order deterministically", () => {
    const result = expand(
      anonymousObject([
        property("zeta", intrinsic("any")),
        property("alpha", intrinsic("unknown")),
      ]),
    );

    expect(result.diagnostics[0]?.message).toContain("`alpha`");
    expect(result.diagnostics[1]?.message).toContain("`zeta`");
  });

  test("a field whose type is unavailable is rejected", () => {
    const result = expand(anonymousObject([property("broken", undefined)]));

    expect(result.table).toBeUndefined();
    expect(codesOf(result)).toEqual(["INVALID_CONTRACT_TYPE"]);
    expect(result.diagnostics[0]?.message).toContain("no computable type");
  });
});

describe("discriminated union violations", () => {
  const circle = (tag: StubType) =>
    anonymousObject([property("kind", tag), property("radius", intrinsic("number"))]);
  const square = (tag: StubType) =>
    anonymousObject([property("kind", tag), property("side", intrinsic("number"))]);

  test("an object union with no common field is rejected", () => {
    const result = expand(
      anonymousObject([
        property(
          "shape",
          union([
            anonymousObject([property("a", stringLiteral("x"))]),
            anonymousObject([property("b", stringLiteral("y"))]),
          ]),
        ),
      ]),
    );

    expect(result.table).toBeUndefined();
    expect(codesOf(result)).toEqual(["CONTRACT_UNION_NOT_DISCRIMINATED"]);
  });

  test("a discriminant candidate with clashing values is rejected", () => {
    const result = expand(
      anonymousObject([
        property("shape", union([circle(stringLiteral("same")), square(stringLiteral("same"))])),
      ]),
    );

    expect(result.table).toBeUndefined();
    expect(codesOf(result)).toEqual(["CONTRACT_UNION_NOT_DISCRIMINATED"]);
    expect(result.diagnostics[0]?.message).toContain("repeats the same literal");
  });

  test("an optional discriminant candidate is rejected", () => {
    const optionalTagged = anonymousObject([
      property("kind", stringLiteral("circle"), true),
      property("radius", intrinsic("number")),
    ]);

    const result = expand(
      anonymousObject([
        property("shape", union([optionalTagged, square(stringLiteral("square"))])),
      ]),
    );

    expect(result.table).toBeUndefined();
    expect(codesOf(result)).toEqual(["CONTRACT_UNION_NOT_DISCRIMINATED"]);
    expect(result.diagnostics[0]?.message).toContain("optional");
  });

  test("a multi-literal discriminant candidate is rejected", () => {
    const multiTagged = anonymousObject([
      property("kind", union([stringLiteral("a"), stringLiteral("b")])),
      property("radius", intrinsic("number")),
    ]);

    const result = expand(
      anonymousObject([property("shape", union([multiTagged, square(stringLiteral("square"))]))]),
    );

    expect(result.table).toBeUndefined();
    expect(codesOf(result)).toEqual(["CONTRACT_UNION_NOT_DISCRIMINATED"]);
    expect(result.diagnostics[0]?.message).toContain("not a single literal");
  });
});

describe("scalars, literals, and nullability", () => {
  test("all six scalar kinds expand to scalar shapes", () => {
    const table = tableOf(
      anonymousObject([
        property("a", intrinsic("string")),
        property("b", intrinsic("number")),
        property("c", intrinsic("bigint")),
        property("d", intrinsic("boolean")),
        property("e", dateType()),
        property("f", intrinsic("null")),
      ]),
    );

    expect(table.root).toEqual({
      kind: "object",
      nullable: false,
      fields: [
        {
          name: "a",
          optional: false,
          shape: { kind: "scalar", scalar: "string", nullable: false },
        },
        {
          name: "b",
          optional: false,
          shape: { kind: "scalar", scalar: "number", nullable: false },
        },
        {
          name: "c",
          optional: false,
          shape: { kind: "scalar", scalar: "bigint", nullable: false },
        },
        {
          name: "d",
          optional: false,
          shape: { kind: "scalar", scalar: "boolean", nullable: false },
        },
        { name: "e", optional: false, shape: { kind: "scalar", scalar: "date", nullable: false } },
        { name: "f", optional: false, shape: { kind: "scalar", scalar: "null", nullable: false } },
      ],
    });
  });

  test("an optional property keeps its scalar shape and marks optional", () => {
    const table = tableOf(anonymousObject([property("a", intrinsic("number"), true)]));

    expect(table.root).toEqual({
      kind: "object",
      nullable: false,
      fields: [
        { name: "a", optional: true, shape: { kind: "scalar", scalar: "number", nullable: false } },
      ],
    });
  });

  test("undefined in a property union is stripped into optionality", () => {
    const table = tableOf(
      anonymousObject([property("a", union([intrinsic("number"), intrinsic("undefined")]))]),
    );

    expect(table.root).toEqual({
      kind: "object",
      nullable: false,
      fields: [
        { name: "a", optional: true, shape: { kind: "scalar", scalar: "number", nullable: false } },
      ],
    });
  });

  test("null in a union becomes the nullable flag", () => {
    const table = tableOf(
      anonymousObject([property("a", union([intrinsic("string"), intrinsic("null")]))]),
    );

    expect(table.root).toEqual({
      kind: "object",
      nullable: false,
      fields: [
        { name: "a", optional: false, shape: { kind: "scalar", scalar: "string", nullable: true } },
      ],
    });
  });

  test("a literal union folds and sorts by (scalar, value)", () => {
    const table = tableOf(
      anonymousObject([
        property(
          "status",
          union([
            stringLiteral("pending"),
            literal({ kind: "number", value: 2 }),
            stringLiteral("done"),
          ]),
        ),
      ]),
    );

    expect(table.root).toEqual({
      kind: "object",
      nullable: false,
      fields: [
        {
          name: "status",
          optional: false,
          shape: {
            kind: "literal",
            nullable: false,
            values: [
              { scalar: "number", value: 2 },
              { scalar: "string", value: "done" },
              { scalar: "string", value: "pending" },
            ],
          },
        },
      ],
    });
  });

  test("true and false together merge back into scalar boolean", () => {
    const table = tableOf(
      anonymousObject([
        property(
          "flag",
          union([
            literal({ kind: "boolean", value: true }),
            literal({ kind: "boolean", value: false }),
          ]),
        ),
      ]),
    );

    expect(table.root).toEqual({
      kind: "object",
      nullable: false,
      fields: [
        {
          name: "flag",
          optional: false,
          shape: { kind: "scalar", scalar: "boolean", nullable: false },
        },
      ],
    });
  });

  test("a lone true literal stays a literal", () => {
    const table = tableOf(
      anonymousObject([property("flag", literal({ kind: "boolean", value: true }))]),
    );

    expect(table.root).toEqual({
      kind: "object",
      nullable: false,
      fields: [
        {
          name: "flag",
          optional: false,
          shape: {
            kind: "literal",
            nullable: false,
            values: [{ scalar: "boolean", value: true }],
          },
        },
      ],
    });
  });

  test("boolean mixed with further literals is rejected", () => {
    const result = expand(
      anonymousObject([
        property(
          "flag",
          union([
            literal({ kind: "boolean", value: true }),
            literal({ kind: "boolean", value: false }),
            stringLiteral("maybe"),
          ]),
        ),
      ]),
    );

    expect(result.table).toBeUndefined();
    expect(codesOf(result)).toEqual(["INVALID_CONTRACT_TYPE"]);
  });
});

describe("nesting and ordering", () => {
  test("nested objects, arrays, and nullable elements expand recursively", () => {
    const table = tableOf(
      anonymousObject([
        property(
          "order",
          anonymousObject([
            property("items", array(union([intrinsic("string"), intrinsic("null")]))),
          ]),
        ),
      ]),
    );

    expect(table.root).toEqual({
      kind: "object",
      nullable: false,
      fields: [
        {
          name: "order",
          optional: false,
          shape: {
            kind: "object",
            nullable: false,
            fields: [
              {
                name: "items",
                optional: false,
                shape: {
                  kind: "array",
                  nullable: false,
                  element: { kind: "scalar", scalar: "string", nullable: true },
                },
              },
            ],
          },
        },
      ],
    });
  });

  test("fields sort by UTF-16 name order", () => {
    const table = tableOf(
      anonymousObject([
        property("zeta", intrinsic("string")),
        property("alpha", intrinsic("string")),
      ]),
    );

    expect(
      table.root.kind === "object" ? table.root.fields.map((field) => field.name) : [],
    ).toEqual(["alpha", "zeta"]);
  });

  test("a discriminated union extracts the tag and sorts members", () => {
    const table = tableOf(
      anonymousObject([
        property(
          "shape",
          union([
            anonymousObject([
              property("kind", stringLiteral("square")),
              property("side", intrinsic("number")),
            ]),
            anonymousObject([
              property("kind", stringLiteral("circle")),
              property("radius", intrinsic("number")),
            ]),
          ]),
        ),
      ]),
    );

    const shape = table.root.kind === "object" ? table.root.fields[0]?.shape : undefined;
    expect(shape?.kind).toBe("union");
    if (shape?.kind !== "union") {
      throw new Error("expected union shape");
    }
    expect(shape.discriminant).toBe("kind");
    expect(shape.members.map((member) => member.tag)).toEqual([
      { scalar: "string", value: "circle" },
      { scalar: "string", value: "square" },
    ]);
  });

  test("two expansions of the same type are deeply equal", () => {
    const type = anonymousObject([
      property("user", namedObject("User", [property("name", intrinsic("string"))])),
      property("tags", array(intrinsic("string"))),
    ]);

    expect(expand(type)).toEqual(expand(type));
  });
});

describe("recursion and definition promotion", () => {
  test("a directly self-referential named type closes through one definition", () => {
    const tree = namedObject("Category", [property("name", intrinsic("string"))]);
    tree.properties = [...tree.properties, property("children", array(tree))];

    const table = tableOf(tree);

    expect(table.root).toEqual({
      kind: "reference",
      target: "src/contracts.ts#Category",
      nullable: false,
    });
    expect(Object.keys(table.definitions)).toEqual(["src/contracts.ts#Category"]);
    expect(table.definitions["src/contracts.ts#Category"]?.shape).toEqual({
      kind: "object",
      nullable: false,
      fields: [
        {
          name: "children",
          optional: false,
          shape: {
            kind: "array",
            nullable: false,
            element: { kind: "reference", target: "src/contracts.ts#Category", nullable: false },
          },
        },
        {
          name: "name",
          optional: false,
          shape: { kind: "scalar", scalar: "string", nullable: false },
        },
      ],
    });
  });

  test("an indirect cycle across two named types closes through two definitions", () => {
    const nodeA = namedObject("NodeA", []);
    const nodeB = namedObject("NodeB", []);
    nodeA.properties = [property("b", union([nodeB, intrinsic("null")]))];
    nodeB.properties = [property("a", array(nodeA))];

    const table = tableOf(nodeA);

    expect(Object.keys(table.definitions)).toEqual([
      "src/contracts.ts#NodeA",
      "src/contracts.ts#NodeB",
    ]);
    expect(table.definitions["src/contracts.ts#NodeA"]?.shape).toEqual({
      kind: "object",
      nullable: false,
      fields: [
        {
          name: "b",
          optional: false,
          shape: { kind: "reference", target: "src/contracts.ts#NodeB", nullable: true },
        },
      ],
    });
  });

  test("a back edge through an optional undefined union stays a reference and turns optional", () => {
    const node = namedObject("LinkedNode", []);
    node.properties = [property("next", union([node, intrinsic("undefined")]))];

    const table = tableOf(node);

    expect(table.definitions["src/contracts.ts#LinkedNode"]?.shape).toEqual({
      kind: "object",
      nullable: false,
      fields: [
        {
          name: "next",
          optional: true,
          shape: { kind: "reference", target: "src/contracts.ts#LinkedNode", nullable: false },
        },
      ],
    });
  });

  test("two references to the same named type share one definition", () => {
    const user = namedObject("User", [property("name", intrinsic("string"))]);

    const table = tableOf(anonymousObject([property("author", user), property("reviewer", user)]));

    expect(Object.keys(table.definitions)).toEqual(["src/contracts.ts#User"]);
    expect(table.root).toEqual({
      kind: "object",
      nullable: false,
      fields: [
        {
          name: "author",
          optional: false,
          shape: { kind: "reference", target: "src/contracts.ts#User", nullable: false },
        },
        {
          name: "reviewer",
          optional: false,
          shape: { kind: "reference", target: "src/contracts.ts#User", nullable: false },
        },
      ],
    });
  });

  test("anonymous inline objects never enter the definitions table", () => {
    const table = tableOf(
      anonymousObject([property("inline", anonymousObject([property("x", intrinsic("number"))]))]),
    );

    expect(table.definitions).toEqual({});
  });

  test("a named discriminated union is promoted with reference members", () => {
    const circle = namedObject("Circle", [
      property("kind", stringLiteral("circle")),
      property("radius", intrinsic("number")),
    ]);
    const square = namedObject("Square", [
      property("kind", stringLiteral("square")),
      property("side", intrinsic("number")),
    ]);
    const shape = union([circle, square], projectNamed("Shape"));

    const table = tableOf(anonymousObject([property("shape", shape)]));

    expect(Object.keys(table.definitions)).toEqual([
      "src/contracts.ts#Circle",
      "src/contracts.ts#Shape",
      "src/contracts.ts#Square",
    ]);
    expect(table.root.kind === "object" ? table.root.fields[0]?.shape : undefined).toEqual({
      kind: "reference",
      target: "src/contracts.ts#Shape",
      nullable: false,
    });
    expect(table.definitions["src/contracts.ts#Shape"]?.shape).toEqual({
      kind: "union",
      discriminant: "kind",
      nullable: false,
      members: [
        {
          tag: { scalar: "string", value: "circle" },
          shape: { kind: "reference", target: "src/contracts.ts#Circle", nullable: false },
        },
        {
          tag: { scalar: "string", value: "square" },
          shape: { kind: "reference", target: "src/contracts.ts#Square", nullable: false },
        },
      ],
    });
  });

  test("a named literal union stays inline instead of being promoted", () => {
    const status = union([stringLiteral("open"), stringLiteral("closed")], projectNamed("Status"));

    const table = tableOf(anonymousObject([property("status", status)]));

    expect(table.definitions).toEqual({});
    expect(table.root.kind === "object" ? table.root.fields[0]?.shape.kind : undefined).toBe(
      "literal",
    );
  });

  test("a reference use site carries nullable from the union", () => {
    const user = namedObject("User", [property("name", intrinsic("string"))]);

    const table = tableOf(anonymousObject([property("owner", union([user, intrinsic("null")]))]));

    expect(table.root.kind === "object" ? table.root.fields[0]?.shape : undefined).toEqual({
      kind: "reference",
      target: "src/contracts.ts#User",
      nullable: true,
    });
  });

  test("definitions keys pair the declaring file with the type name and sort", () => {
    const left = namedObject("Zed", [], "src/b.ts");
    const right = namedObject("Alpha", [], "src/a.ts");

    const table = tableOf(anonymousObject([property("l", left), property("r", right)]));

    expect(Object.keys(table.definitions)).toEqual(["src/a.ts#Alpha", "src/b.ts#Zed"]);
  });
});

describe("property-based expansion", () => {
  interface ModelField {
    readonly name: string;
    readonly optional: boolean;
    readonly nullable: boolean;
    readonly model: Model;
  }
  type Model =
    | { readonly m: "scalar"; readonly scalar: "string" | "number" | "bigint" | "boolean" }
    | { readonly m: "array"; readonly element: Model }
    | { readonly m: "object"; readonly fields: readonly ModelField[] };

  const { model } = fc.letrec((tie) => ({
    model: fc.oneof(
      { maxDepth: 4, withCrossShrink: true },
      fc.record({
        m: fc.constant("scalar" as const),
        scalar: fc.constantFrom(
          "string" as const,
          "number" as const,
          "bigint" as const,
          "boolean" as const,
        ),
      }),
      fc.record({ m: fc.constant("array" as const), element: tie("model") as fc.Arbitrary<Model> }),
      fc.record({
        m: fc.constant("object" as const),
        fields: fc.uniqueArray(
          fc.record({
            name: fc.stringMatching(/^[a-z][a-z0-9]{0,6}$/),
            optional: fc.boolean(),
            nullable: fc.boolean(),
            model: tie("model") as fc.Arbitrary<Model>,
          }),
          { maxLength: 5, selector: (field) => field.name },
        ),
      }),
    ),
  }));

  function stubOf(node: Model): StubType {
    if (node.m === "scalar") {
      return intrinsic(node.scalar);
    }
    if (node.m === "array") {
      return array(stubOf(node.element));
    }
    return anonymousObject(
      node.fields.map((field) => {
        const base = stubOf(field.model);
        const withNull = field.nullable ? union([base, intrinsic("null")]) : base;
        return property(field.name, withNull, field.optional);
      }),
    );
  }

  function assertObjectMatches(
    shape: ContractShape & { readonly kind: "object" },
    node: Model & { readonly m: "object" },
  ): void {
    const sorted = [...node.fields].toSorted((a, b) => (a.name < b.name ? -1 : 1));
    expect(shape.fields.map((field) => field.name)).toEqual(sorted.map((field) => field.name));
    for (const [index, field] of shape.fields.entries()) {
      const expected = sorted[index];
      if (expected === undefined) {
        throw new Error("field count mismatch");
      }
      expect(field.optional).toBe(expected.optional);
      assertMatches(field.shape, expected.model, expected.nullable);
    }
  }

  function assertMatches(shape: ContractShape, node: Model, nullable: boolean): void {
    expect(shape.nullable).toBe(nullable);
    if (node.m === "scalar") {
      if (shape.kind !== "scalar") {
        throw new Error(`expected scalar, got ${shape.kind}`);
      }
      expect(shape.scalar).toBe(node.scalar);
      return;
    }
    if (node.m === "array") {
      if (shape.kind !== "array") {
        throw new Error(`expected array, got ${shape.kind}`);
      }
      assertMatches(shape.element, node.element, false);
      return;
    }
    if (shape.kind !== "object") {
      throw new Error(`expected object, got ${shape.kind}`);
    }
    assertObjectMatches(shape, node);
  }

  test("random anonymous shapes expand isomorphically without losing fields", () => {
    fc.assert(
      fc.property(model, (node) => {
        const result = expand(stubOf(node));

        expect(result.diagnostics).toEqual([]);
        if (result.table === undefined) {
          throw new Error("expected table");
        }
        expect(result.table.definitions).toEqual({});
        assertMatches(result.table.root, node, false);
      }),
      { numRuns: 60 },
    );
  });

  type EdgeWrapper = "array" | "nullable" | "optionalUndefined";

  function wrapEdge(wrap: EdgeWrapper | undefined, target: StubType): StubType {
    if (wrap === "array") {
      return array(target);
    }
    if (wrap === "nullable") {
      return union([target, intrinsic("null")]);
    }
    return union([target, intrinsic("undefined")]);
  }

  // 命名链 T0 → T1 → … → T(depth-1) → 回到 T0,每一跳随机套 array/null/undefined 包装。
  function buildNamedChain(depth: number, wrapper: readonly EdgeWrapper[]): StubType {
    const nodes = Array.from({ length: depth }, (_value, index) => namedObject(`T${index}`, []));
    for (const [index, node] of nodes.entries()) {
      const target = nodes[(index + 1) % depth];
      if (target === undefined) {
        throw new Error("unreachable");
      }
      node.properties = [property("next", wrapEdge(wrapper[index % wrapper.length], target))];
    }
    const first = nodes[0];
    if (first === undefined) {
      throw new Error("unreachable");
    }
    return first;
  }

  function collectReferences(shape: ContractShape): string[] {
    switch (shape.kind) {
      case "reference":
        return [shape.target];
      case "array":
        return collectReferences(shape.element);
      case "object":
        return shape.fields.flatMap((field) => collectReferences(field.shape));
      case "union":
        return shape.members.flatMap((member) => collectReferences(member.shape));
      default:
        return [];
    }
  }

  test("random named chains with back edges terminate with a closed table", () => {
    const chain = fc.record({
      depth: fc.integer({ min: 1, max: 6 }),
      wrapper: fc.array(fc.constantFrom<EdgeWrapper>("array", "nullable", "optionalUndefined"), {
        minLength: 1,
        maxLength: 6,
      }),
    });
    fc.assert(
      fc.property(chain, ({ depth, wrapper }) => {
        const first = buildNamedChain(depth, wrapper);

        const once = expand(first);
        const twice = expand(first);

        expect(once.diagnostics).toEqual([]);
        expect(once).toEqual(twice);
        if (once.table === undefined) {
          throw new Error("expected table");
        }
        const definitionKeys = new Set(Object.keys(once.table.definitions));
        expect(definitionKeys.size).toBe(depth);
        const references = [
          ...collectReferences(once.table.root),
          ...Object.values(once.table.definitions).flatMap((definition) =>
            collectReferences(definition.shape),
          ),
        ];
        expect(references.length).toBeGreaterThan(0);
        for (const reference of references) {
          expect(definitionKeys.has(reference)).toBe(true);
        }
      }),
      { numRuns: 40 },
    );
  });
});
