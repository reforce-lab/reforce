import type {
  ManifestContractShape,
  ManifestContractTable,
  ManifestLiteralValue,
} from "@/project/route-manifest";

// 契约字段表 → JSON Schema(#306):字段表本身就是 JSON Schema $defs 精神的闭集(#273),
// 这里是近似恒等映射。OpenAPI 3.2 的 schema 方言即 JSON Schema 2020-12,nullable 用
// type 数组表达;引用与 oneOf 位不能进 type 数组,包一层 oneOf + {type:"null"}。

export type OpenApiSchema = Record<string, unknown>;

// definitions key(`${fileId}#${typeName}`) → components/schemas 组件名。typeName 全表唯一
// 时用裸名;冲突的**全体**降级为 `${typeName}__${消毒后的 fileId}`——只给后来者加后缀会让
// 组件名随路由遍历顺序漂移,全体降级才是确定性的。
export function componentNamesOf(
  tables: readonly ManifestContractTable[],
): ReadonlyMap<string, string> {
  const keysByTypeName = new Map<string, Set<string>>();
  for (const table of tables) {
    for (const [key, definition] of Object.entries(table.definitions)) {
      const keys = keysByTypeName.get(definition.typeName) ?? new Set<string>();
      keys.add(key);
      keysByTypeName.set(definition.typeName, keys);
    }
  }
  const names = new Map<string, string>();
  for (const [typeName, keys] of keysByTypeName) {
    for (const key of keys) {
      names.set(key, keys.size === 1 ? typeName : componentNameWithFileId(key, typeName));
    }
  }
  return names;
}

// OpenAPI 组件键的合法字符集是 ^[a-zA-Z0-9.\-_]+$;fileId 里的 / 与 # 都得消毒。
function componentNameWithFileId(definitionKey: string, typeName: string): string {
  const fileId = definitionKey.slice(0, definitionKey.length - typeName.length - 1);
  return `${typeName}__${fileId.replace(/[^a-zA-Z0-9.\-_]/g, "_")}`;
}

function referenceTo(componentName: string): OpenApiSchema {
  return { $ref: `#/components/schemas/${componentName}` };
}

// 线上的 bigint 是十进制字符串(生成编码器把 bigint 叶归一成 String(value));解码方向
// body 里的 JSON 整数同样被收下,description 把这份宽容写进文档。
const bigintSchema: OpenApiSchema = {
  type: "string",
  format: "int64",
  pattern: "^-?[0-9]+$",
  description:
    "Decimal string on the wire; request bodies also accept a plain JSON integer for this field.",
};

const scalarSchemas: Readonly<Record<string, OpenApiSchema>> = {
  string: { type: "string" },
  number: { type: "number" },
  boolean: { type: "boolean" },
  date: { type: "string", format: "date-time" },
  null: { type: "null" },
  bigint: bigintSchema,
};

function withNullableType(schema: OpenApiSchema, nullable: boolean): OpenApiSchema {
  if (!nullable) {
    return schema;
  }
  const type = schema.type;
  if (typeof type === "string" && type !== "null") {
    return { ...schema, type: [type, "null"] };
  }
  return schema;
}

function literalSchema(values: readonly ManifestLiteralValue[], nullable: boolean): OpenApiSchema {
  // bigint 字面量在表里已是十进制字符串,直接作为 string 枚举出线(与编码后的线上值一致)。
  const literals: readonly (string | number | boolean)[] = values.map((value) => value.value);
  const scalars = new Set(
    values.map((value) => (value.scalar === "bigint" ? "string" : value.scalar)),
  );
  const type = scalars.size === 1 ? [...scalars][0] : undefined;
  if (nullable) {
    return {
      ...(type === undefined ? {} : { type: [type, "null"] }),
      enum: [...literals, null],
    };
  }
  if (literals.length === 1) {
    return { ...(type === undefined ? {} : { type }), const: literals[0] };
  }
  return { ...(type === undefined ? {} : { type }), enum: literals };
}

export function jsonSchemaOf(
  shape: ManifestContractShape,
  nameOf: ReadonlyMap<string, string>,
): OpenApiSchema {
  switch (shape.kind) {
    case "scalar":
      return withNullableType({ ...scalarSchemas[shape.scalar] }, shape.nullable);
    case "literal":
      return literalSchema(shape.values, shape.nullable);
    case "array":
      return withNullableType(
        { type: "array", items: jsonSchemaOf(shape.element, nameOf) },
        shape.nullable,
      );
    case "object": {
      const properties: Record<string, OpenApiSchema> = {};
      for (const field of shape.fields) {
        properties[field.name] = jsonSchemaOf(field.shape, nameOf);
      }
      const required = shape.fields.filter((field) => !field.optional).map((field) => field.name);
      return withNullableType(
        {
          type: "object",
          properties,
          ...(required.length === 0 ? {} : { required }),
          // 编码器就是白名单:未声明字段运行时不出线,文档如实收紧。
          additionalProperties: false,
        },
        shape.nullable,
      );
    }
    case "union": {
      const members = shape.members.map((member) => jsonSchemaOf(member.shape, nameOf));
      // discriminator 的 mapping 值必须是 $ref;有内联成员就只出 oneOf,不写残缺的映射表。
      const allReferences = shape.members.every((member) => member.shape.kind === "reference");
      const union: OpenApiSchema = {
        oneOf: members,
        ...(allReferences
          ? {
              discriminator: {
                propertyName: shape.discriminant,
                mapping: discriminatorMapping(shape.members, nameOf),
              },
            }
          : {}),
      };
      return shape.nullable ? { oneOf: [union, { type: "null" }] } : union;
    }
    case "reference": {
      const reference = referenceTo(nameOf.get(shape.target) ?? shape.target);
      return shape.nullable ? { oneOf: [reference, { type: "null" }] } : reference;
    }
  }
}

function discriminatorMapping(
  members: readonly { readonly tag: ManifestLiteralValue; readonly shape: ManifestContractShape }[],
  nameOf: ReadonlyMap<string, string>,
): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const member of members) {
    if (member.shape.kind !== "reference") {
      continue;
    }
    const componentName = nameOf.get(member.shape.target) ?? member.shape.target;
    mapping[String(member.tag.value)] = `#/components/schemas/${componentName}`;
  }
  return mapping;
}
