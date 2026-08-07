import type { ContractShape, ContractTable } from "@/analysis/type-contract";

// 编码器生成(RFC 0012 S2,#274):响应白名单投影,任意深度逐字段直写。bigint→String、
// Date 位归一 ISO(webEncodeDate,preamble 提供)、string/number/boolean/字面量直搬、
// 叶子 null/undefined 原样保留、可选字段缺不出键、数组 map、嵌套递归、判别联合按判别字段
// 分派、NaN/Infinity 不拦。reference(definitions 提升的类型)生成具名辅助函数闭合递归。

function quoted(value: string): string {
  return JSON.stringify(value);
}

function indented(lines: readonly string[], indent: string): readonly string[] {
  return lines.map((line) => (line.length === 0 ? line : `${indent}${line}`));
}

function literalText(value: {
  readonly scalar: "string" | "number" | "bigint" | "boolean";
  readonly value: string | number | boolean;
}): string {
  if (value.scalar === "string") {
    return quoted(String(value.value));
  }
  if (value.scalar === "bigint") {
    return `${String(value.value)}n`;
  }
  return String(value.value);
}

interface EncoderGenContext {
  readonly declarations: string[];
  readonly definitionNames: ReadonlyMap<string, string>;
  counter: number;
}

function encodeObjectBody(
  shape: Extract<ContractShape, { readonly kind: "object" }>,
  context: EncoderGenContext,
): readonly string[] {
  const lines: string[] = [
    "// 投影读取按白名单逐字段;handler 返回值类型已由 invoke 处的 tsc 背书",
    "const source = value as Record<string, unknown>;",
    "const result: Record<string, unknown> = {};",
  ];
  for (const field of shape.fields) {
    const fieldFn = encoderShapeFunction(field.shape, context);
    const key = quoted(field.name);
    if (field.optional) {
      lines.push(
        `if (source[${key}] !== undefined) {`,
        `  result[${key}] = ${fieldFn}(source[${key}]);`,
        "}",
      );
      continue;
    }
    lines.push(`result[${key}] = ${fieldFn}(source[${key}]);`);
  }
  lines.push("return result;");
  return lines;
}

function encodeUnionBody(
  shape: Extract<ContractShape, { readonly kind: "union" }>,
  context: EncoderGenContext,
): readonly string[] {
  const discriminant = quoted(shape.discriminant);
  const lines: string[] = [
    "const source = value as Record<string, unknown>;",
    `const tag = source[${discriminant}];`,
  ];
  for (const member of shape.members) {
    const memberFn = encoderShapeFunction(member.shape, context);
    lines.push(`if (tag === ${literalText(member.tag)}) {`, `  return ${memberFn}(value);`, "}");
  }
  // 运行时撞不上的 tag:返回 undefined(JSON.stringify 对 undefined 不抛,数组位序列化为 null),
  // 不透传——透传可能携带 bigint 让 stringify 抛。
  lines.push("return undefined;");
  return lines;
}

function encoderShapeBody(shape: ContractShape, context: EncoderGenContext): readonly string[] {
  if (shape.kind === "scalar") {
    if (shape.scalar === "bigint") {
      return ['return typeof value === "bigint" ? String(value) : value;'];
    }
    if (shape.scalar === "date") {
      return ["return webEncodeDate(value);"];
    }
    if (shape.scalar === "string") {
      // string 叶归一(#275):@ResponseSchema 的 R≠C 放宽允许域值带 bigint/Date,编码器把
      // 「精确 schema」落到字面,不再依赖 renderJson 慢路径的 replacer 重试。
      return [
        'if (typeof value === "bigint") {',
        "  return String(value);",
        "}",
        "return value instanceof Date ? webEncodeDate(value) : value;",
      ];
    }
    return ["return value;"];
  }
  if (shape.kind === "literal") {
    const hasBigInt = shape.values.some((value) => value.scalar === "bigint");
    if (hasBigInt) {
      return ['return typeof value === "bigint" ? String(value) : value;'];
    }
    return ["return value;"];
  }
  if (shape.kind === "object") {
    return encodeObjectBody(shape, context);
  }
  if (shape.kind === "array") {
    const elementFn = encoderShapeFunction(shape.element, context);
    return [
      "if (!Array.isArray(value)) {",
      "  return value;",
      "}",
      `return value.map((item) => ${elementFn}(item));`,
    ];
  }
  if (shape.kind === "union") {
    return encodeUnionBody(shape, context);
  }
  throw new Error("Unexpected reference shape in encoder generation.");
}

function declareEncoderFunction(
  name: string,
  shape: ContractShape,
  context: EncoderGenContext,
): void {
  context.declarations.push(
    [
      `  const ${name} = (value: unknown): unknown => {`,
      // 叶子对 null/undefined 原样保留;必选字段照常出键,值为 null/undefined 时原样落位。
      "    if (value === null || value === undefined) {",
      "      return value;",
      "    }",
      ...indented(encoderShapeBody(shape, context), "    "),
      "  };",
    ].join("\n"),
  );
}

function encoderShapeFunction(shape: ContractShape, context: EncoderGenContext): string {
  if (shape.kind === "reference") {
    const definitionName = context.definitionNames.get(shape.target);
    if (definitionName === undefined) {
      throw new Error(`Missing contract definition ${shape.target} in encoder generation.`);
    }
    return definitionName;
  }
  const name = `encode${context.counter}`;
  context.counter += 1;
  declareEncoderFunction(name, shape, context);
  return name;
}

// 响应编码器:const <name> = (value: unknown) => unknown;白名单外键永不出现在产物里。
export function renderResponseEncoder(name: string, table: ContractTable): string {
  const definitionKeys = Object.keys(table.definitions);
  const definitionNames = new Map(definitionKeys.map((key, index) => [key, `encodeDef${index}`]));
  const context: EncoderGenContext = { declarations: [], definitionNames, counter: 0 };
  for (const key of definitionKeys) {
    const definition = table.definitions[key];
    const fnName = definitionNames.get(key);
    if (definition !== undefined && fnName !== undefined) {
      declareEncoderFunction(fnName, definition.shape, context);
    }
  }
  const rootFn = encoderShapeFunction(table.root, context);
  return [
    `const ${name} = (() => {`,
    ...context.declarations,
    `  return (value: unknown): unknown => ${rootFn}(value);`,
    "})();",
  ].join("\n");
}
