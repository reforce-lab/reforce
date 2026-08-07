import { describe, expect, test } from "vitest";
import { componentNamesOf, jsonSchemaOf } from "@/openapi/schema";
import type { ManifestContractShape, ManifestContractTable } from "@/project/route-manifest";

// 字段表 → JSON Schema 的映射规则(#306):闭集逐个钉住。nameOf 为空 Map 时引用按
// definitions key 原样出线,组件命名单独测。

const noNames: ReadonlyMap<string, string> = new Map();

function scalar(
  kind: "string" | "number" | "bigint" | "boolean" | "date" | "null",
  nullable = false,
): ManifestContractShape {
  return { kind: "scalar", scalar: kind, nullable };
}

describe("jsonSchemaOf scalars", () => {
  test.each([
    ["string", { type: "string" }],
    ["number", { type: "number" }],
    ["boolean", { type: "boolean" }],
    ["null", { type: "null" }],
  ] as const)("%s maps to its JSON Schema type", (kind, expected) => {
    expect(jsonSchemaOf(scalar(kind), noNames)).toEqual(expected);
  });

  // 线上 bigint 是十进制字符串(编码器归一),pattern 拒空串与小数。
  test("bigint maps to a decimal string with int64 format", () => {
    const schema = jsonSchemaOf(scalar("bigint"), noNames);

    expect(schema).toMatchObject({ type: "string", format: "int64", pattern: "^-?[0-9]+$" });
    expect(typeof schema.description).toBe("string");
  });

  test("date maps to a date-time string", () => {
    expect(jsonSchemaOf(scalar("date"), noNames)).toEqual({
      type: "string",
      format: "date-time",
    });
  });

  test("a nullable scalar widens type into an array", () => {
    expect(jsonSchemaOf(scalar("number", true), noNames)).toEqual({ type: ["number", "null"] });
  });
});

describe("jsonSchemaOf literals", () => {
  test("a single literal becomes const", () => {
    const shape: ManifestContractShape = {
      kind: "literal",
      values: [{ scalar: "string", value: "ok" }],
      nullable: false,
    };

    expect(jsonSchemaOf(shape, noNames)).toEqual({ type: "string", const: "ok" });
  });

  test("a literal union becomes enum", () => {
    const shape: ManifestContractShape = {
      kind: "literal",
      values: [
        { scalar: "string", value: "asc" },
        { scalar: "string", value: "desc" },
      ],
      nullable: false,
    };

    expect(jsonSchemaOf(shape, noNames)).toEqual({ type: "string", enum: ["asc", "desc"] });
  });

  test("a nullable literal folds null into the enum", () => {
    const shape: ManifestContractShape = {
      kind: "literal",
      values: [{ scalar: "number", value: 1 }],
      nullable: true,
    };

    expect(jsonSchemaOf(shape, noNames)).toEqual({ type: ["number", "null"], enum: [1, null] });
  });

  // bigint 字面量在表里已是十进制字符串,按 string 枚举出线。
  test("bigint literals enumerate as strings", () => {
    const shape: ManifestContractShape = {
      kind: "literal",
      values: [
        { scalar: "bigint", value: "1" },
        { scalar: "bigint", value: "9007199254740993" },
      ],
      nullable: false,
    };

    expect(jsonSchemaOf(shape, noNames)).toEqual({
      type: "string",
      enum: ["1", "9007199254740993"],
    });
  });
});

describe("jsonSchemaOf containers", () => {
  test("an object closes with properties, required, and additionalProperties false", () => {
    const shape: ManifestContractShape = {
      kind: "object",
      nullable: false,
      fields: [
        { name: "id", optional: false, shape: scalar("string") },
        { name: "note", optional: true, shape: scalar("string") },
      ],
    };

    expect(jsonSchemaOf(shape, noNames)).toEqual({
      type: "object",
      properties: { id: { type: "string" }, note: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    });
  });

  test("an array maps to items; nullable widens the array type", () => {
    const shape: ManifestContractShape = {
      kind: "array",
      element: scalar("number"),
      nullable: true,
    };

    expect(jsonSchemaOf(shape, noNames)).toEqual({
      type: ["array", "null"],
      items: { type: "number" },
    });
  });

  test("a reference maps to $ref through the component name table", () => {
    const names = new Map([["src/users.ts#User", "User"]]);
    const shape: ManifestContractShape = {
      kind: "reference",
      target: "src/users.ts#User",
      nullable: false,
    };

    expect(jsonSchemaOf(shape, names)).toEqual({ $ref: "#/components/schemas/User" });
  });

  // $ref 位不能进 type 数组:nullable 引用包 oneOf。
  test("a nullable reference wraps in oneOf with null", () => {
    const names = new Map([["src/users.ts#User", "User"]]);
    const shape: ManifestContractShape = {
      kind: "reference",
      target: "src/users.ts#User",
      nullable: true,
    };

    expect(jsonSchemaOf(shape, names)).toEqual({
      oneOf: [{ $ref: "#/components/schemas/User" }, { type: "null" }],
    });
  });
});

describe("jsonSchemaOf unions", () => {
  const referenceUnion: ManifestContractShape = {
    kind: "union",
    discriminant: "kind",
    nullable: false,
    members: [
      {
        tag: { scalar: "string", value: "cat" },
        shape: { kind: "reference", target: "src/pets.ts#Cat", nullable: false },
      },
      {
        tag: { scalar: "string", value: "dog" },
        shape: { kind: "reference", target: "src/pets.ts#Dog", nullable: false },
      },
    ],
  };

  test("an all-reference union carries a discriminator with mapping", () => {
    const names = new Map([
      ["src/pets.ts#Cat", "Cat"],
      ["src/pets.ts#Dog", "Dog"],
    ]);

    expect(jsonSchemaOf(referenceUnion, names)).toEqual({
      oneOf: [{ $ref: "#/components/schemas/Cat" }, { $ref: "#/components/schemas/Dog" }],
      discriminator: {
        propertyName: "kind",
        mapping: {
          cat: "#/components/schemas/Cat",
          dog: "#/components/schemas/Dog",
        },
      },
    });
  });

  // discriminator 的 mapping 值必须是 $ref:有内联成员就只出 oneOf。
  test("a union with an inline member drops the discriminator", () => {
    const shape: ManifestContractShape = {
      kind: "union",
      discriminant: "kind",
      nullable: false,
      members: [
        {
          tag: { scalar: "string", value: "cat" },
          shape: { kind: "reference", target: "src/pets.ts#Cat", nullable: false },
        },
        {
          tag: { scalar: "string", value: "other" },
          shape: { kind: "object", nullable: false, fields: [] },
        },
      ],
    };

    const schema = jsonSchemaOf(shape, new Map([["src/pets.ts#Cat", "Cat"]]));

    expect(schema.discriminator).toBeUndefined();
    expect(Array.isArray(schema.oneOf)).toBe(true);
  });

  test("a nullable union wraps in oneOf with null", () => {
    const schema = jsonSchemaOf(
      { ...referenceUnion, nullable: true },
      new Map([
        ["src/pets.ts#Cat", "Cat"],
        ["src/pets.ts#Dog", "Dog"],
      ]),
    );

    expect(schema.oneOf).toHaveLength(2);
    expect((schema.oneOf as unknown[])[1]).toEqual({ type: "null" });
  });
});

describe("componentNamesOf", () => {
  function tableWith(key: string, typeName: string): ManifestContractTable {
    return {
      root: { kind: "reference", target: key, nullable: false },
      definitions: {
        [key]: { typeName, shape: { kind: "object", nullable: false, fields: [] } },
      },
    };
  }

  test("a unique type name keeps its bare name", () => {
    const names = componentNamesOf([tableWith("src/users.ts#User", "User")]);

    expect(names.get("src/users.ts#User")).toBe("User");
  });

  // 冲突时**全体**降级:只给后来者加后缀会让组件名随遍历顺序漂移。
  test("colliding type names all get a sanitized file suffix", () => {
    const names = componentNamesOf([
      tableWith("src/users.ts#User", "User"),
      tableWith("src/admin/users.ts#User", "User"),
    ]);

    expect(names.get("src/users.ts#User")).toBe("User__src_users.ts");
    expect(names.get("src/admin/users.ts#User")).toBe("User__src_admin_users.ts");
  });

  test("a recursive self-reference resolves to its own component name", () => {
    const table: ManifestContractTable = {
      root: { kind: "reference", target: "src/tree.ts#Node", nullable: false },
      definitions: {
        "src/tree.ts#Node": {
          typeName: "Node",
          shape: {
            kind: "object",
            nullable: false,
            fields: [
              {
                name: "children",
                optional: false,
                shape: {
                  kind: "array",
                  nullable: false,
                  element: { kind: "reference", target: "src/tree.ts#Node", nullable: false },
                },
              },
            ],
          },
        },
      },
    };
    const names = componentNamesOf([table]);

    const definition = table.definitions["src/tree.ts#Node"];
    expect(definition).toBeDefined();
    if (definition !== undefined) {
      expect(jsonSchemaOf(definition.shape, names)).toEqual({
        type: "object",
        properties: {
          children: { type: "array", items: { $ref: "#/components/schemas/Node" } },
        },
        required: ["children"],
        additionalProperties: false,
      });
    }
  });
});
