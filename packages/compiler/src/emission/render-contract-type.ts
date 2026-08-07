import type { ContractShape, ContractTable } from "@/analysis/type-contract";

// 槽位元组类型文本(RFC 0012 S2,#274 typed-edge):生成的 routes.ts 被用户项目的真 tsc 检查,
// invoke 里 `slots[i] as <此处文本>` 让 tsc 交叉核对解码产物类型与 handler 参数类型——
// 渲染错了会在生成物上红,而不是运行时炸。递归引用按结构展开,回边渲染 `never`:never 可赋
// 给一切,回边处的赋值兼容性不被破坏,又不需要 import 用户类型(契约类型可能未导出)。

function quotedKey(name: string): string {
  return JSON.stringify(name);
}

function literalTypeText(value: {
  readonly scalar: "string" | "number" | "bigint" | "boolean";
  readonly value: string | number | boolean;
}): string {
  if (value.scalar === "string") {
    return JSON.stringify(String(value.value));
  }
  if (value.scalar === "bigint") {
    return `${String(value.value)}n`;
  }
  return String(value.value);
}

const scalarTypeTexts = {
  string: "string",
  number: "number",
  bigint: "bigint",
  boolean: "boolean",
  date: "Date",
  null: "null",
} as const;

function withNullable(text: string, nullable: boolean): string {
  return nullable ? `${text} | null` : text;
}

function shapeTypeText(shape: ContractShape, table: ContractTable, stack: Set<string>): string {
  if (shape.kind === "scalar") {
    return withNullable(scalarTypeTexts[shape.scalar], shape.nullable);
  }
  if (shape.kind === "literal") {
    return withNullable(
      shape.values.map((value) => literalTypeText(value)).join(" | "),
      shape.nullable,
    );
  }
  if (shape.kind === "object") {
    const fields = shape.fields.map((field) => {
      const optional = field.optional ? "?" : "";
      return `${quotedKey(field.name)}${optional}: ${shapeTypeText(field.shape, table, stack)}`;
    });
    const text = fields.length === 0 ? "{}" : `{ ${fields.join("; ")} }`;
    return withNullable(text, shape.nullable);
  }
  if (shape.kind === "array") {
    const element = shapeTypeText(shape.element, table, stack);
    const wrapped = element.includes("|") || element.includes(";") ? `(${element})` : element;
    return withNullable(`${wrapped}[]`, shape.nullable);
  }
  if (shape.kind === "union") {
    const members = shape.members.map((member) => shapeTypeText(member.shape, table, stack));
    return withNullable(`(${members.join(" | ")})`, shape.nullable);
  }
  if (stack.has(shape.target)) {
    // 递归回边:never 可赋给一切,保持整体可赋性。
    return "never";
  }
  const definition = table.definitions[shape.target];
  if (definition === undefined) {
    return "never";
  }
  stack.add(shape.target);
  const text = shapeTypeText(definition.shape, table, stack);
  stack.delete(shape.target);
  return withNullable(text, shape.nullable);
}

export function contractTypeText(table: ContractTable): string {
  return shapeTypeText(table.root, table, new Set());
}
