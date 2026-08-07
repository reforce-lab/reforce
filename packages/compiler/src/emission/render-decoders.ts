import type { ContractShape, ContractTable } from "@/analysis/type-contract";
import type { BodyRouteSlotModel, StringRouteSlotModel } from "@/analysis/web-model";

// 解码器生成(RFC 0012 S2,#274):每个 source:"type" 数据槽生成一个套 ~standard 壳的常量,
// 与用户 schema 同形,运行时统一按 StandardSchemaV1 消费。编译期按 ContractShape 展开逐字段
// 直写;标量解码基元(数字/大整数/布尔/日期文法)是固定 preamble,任一解码器/编码器存在时
// 发射一次。载体契约(#274 载体表):param 吃 path params record、query 吃 URLSearchParams、
// header 吃原生 Headers(大小写不敏感由它承担)、body 吃严格读体产物(层①在运行时,解码器
// 承担层②定形与层③逐字段)。生成代码要过用户项目的真 tsc(typed-edge),载体收窄用单个 as,
// 由执行链的槽位分派保证。

export const decoderPreamble = `// —— 槽位解码/编码基元(#274):生成的解码器与编码器共用 ——
type WebSlotIssue = { readonly message: string; readonly path?: readonly (string | number)[] };
function webSlotIssue(message: string, path: readonly (string | number)[]): WebSlotIssue {
  if (path.length === 0) {
    return { message };
  }
  return { message, path: [...path] };
}
function webPathText(path: readonly (string | number)[]): string {
  if (path.length === 0) {
    return "value";
  }
  return path.map(String).join(".");
}
// 数字文法:trim 后必须整体是十进制数(可带指数);Number("") === 0、Number("0x10")、
// Number("Infinity") 都是这里要挡的坑;1e3 收下。
const webNumberPattern = /^[+-]?(\\d+\\.?\\d*|\\.\\d+)([eE][+-]?\\d+)?$/;
function webDecodeNumberText(raw: string): number | undefined {
  const text = raw.trim();
  return webNumberPattern.test(text) ? Number(text) : undefined;
}
// bigint 文法预检:裸调 BigInt("1.5") 会抛 SyntaxError。
const webBigIntPattern = /^-?\\d+$/;
function webDecodeBigIntText(raw: string): bigint | undefined {
  const text = raw.trim();
  return webBigIntPattern.test(text) ? BigInt(text) : undefined;
}
function webDecodeBooleanText(raw: string): boolean | undefined {
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  return undefined;
}
function webDecodeDateText(raw: string): Date | undefined {
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
// body 的 bigint 位:number 位用 Number.isInteger(不是 isSafeInteger——精度受限的大数
// 应走字符串位,整数性才是这里的裁决);字符串位走同一文法预检。
function webDecodeBigIntJson(raw: unknown): bigint | undefined {
  if (typeof raw === "bigint") {
    return raw;
  }
  if (typeof raw === "number" && Number.isInteger(raw)) {
    return BigInt(raw);
  }
  if (typeof raw === "string") {
    return webDecodeBigIntText(raw);
  }
  return undefined;
}
function webDecodeDateJson(raw: unknown): Date | undefined {
  return typeof raw === "string" ? webDecodeDateText(raw) : undefined;
}
function webIsPlainObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}
// 响应 Date 位的归一(#264 附录):ISO 串/日期串/epoch 都归一成 ISO,解析不出(getTime NaN)
// 才原样透传;NaN/Infinity 数字不拦。
function webEncodeDate(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  const date = new Date(value as string | number | Date);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}
// 基元是固定全集,具体路由未必每个都用到;void 引用豁免 noUnusedLocals,不按用量裁剪。
void [
  webSlotIssue,
  webPathText,
  webDecodeNumberText,
  webDecodeBigIntText,
  webDecodeBooleanText,
  webDecodeDateText,
  webDecodeBigIntJson,
  webDecodeDateJson,
  webIsPlainObject,
  webEncodeDate,
];
`;

function quoted(value: string): string {
  return JSON.stringify(value);
}

function indented(lines: readonly string[], indent: string): readonly string[] {
  return lines.map((line) => (line.length === 0 ? line : `${indent}${line}`));
}

// 字面量的 TS 源码形态(生成代码里直写)。
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

export function rootShapeOfTable(table: ContractTable): ContractShape {
  return table.root.kind === "reference"
    ? (table.definitions[table.root.target]?.shape ?? table.root)
    : table.root;
}

// ———— 三字符串槽:文本标量解码 ————

interface TextFieldPlan {
  readonly key: string;
  readonly shape: ContractShape;
  readonly optional: boolean;
  // 单键形态 path 为空(issue 直接指槽位);契约形态 path = [字段名]。
  readonly path: readonly string[];
}

const carrierTypes = {
  param: "Readonly<Record<string, string | undefined>>",
  query: "URLSearchParams",
  header: "Headers",
} as const;

function rawExtraction(slot: "param" | "query" | "header", key: string, isArray: boolean): string {
  if (slot === "param") {
    return `carrier[${quoted(key)}]`;
  }
  if (isArray) {
    // 仅 Query 有数组语义(getAll);Param/Header 数组在槽位解析层已硬错。
    return `carrier.getAll(${quoted(key)})`;
  }
  return `carrier.get(${quoted(key)}) ?? undefined`;
}

interface TextDecodeContext {
  readonly helpers: string[];
  counter: number;
}

// 单个文本标量位的解码语句(零缩进,组装时统一缩进):raw(string)→ target 或 issue。
function textScalarLines(
  shape: ContractShape,
  raw: string,
  target: string,
  label: string,
  pathText: string,
  context: TextDecodeContext,
): readonly string[] {
  const issue = (what: string): string =>
    `  issues.push(webSlotIssue(${quoted(`${label} ${what}`)}, ${pathText}));`;
  if (shape.kind === "literal") {
    const mapName = `webLiterals${context.counter}`;
    context.counter += 1;
    const entries = shape.values
      .map((value) => `[${quoted(String(value.value))}, ${literalText(value)}]`)
      .join(", ");
    context.helpers.push(`const ${mapName} = new Map<string, unknown>([${entries}]);`);
    const allowed = shape.values.map((value) => String(value.value)).join(", ");
    return [
      `if (${mapName}.has(${raw})) {`,
      `  ${target} = ${mapName}.get(${raw});`,
      "} else {",
      issue(`must be one of: ${allowed}`),
      "}",
    ];
  }
  if (shape.kind !== "scalar" || shape.scalar === "null") {
    throw new Error(`Text decoding does not support ${shape.kind} shapes.`);
  }
  if (shape.scalar === "string") {
    return [`${target} = ${raw};`];
  }
  const decoderByScalar = {
    number: ["webDecodeNumberText", "must be a number"],
    bigint: ["webDecodeBigIntText", "must be an integer"],
    boolean: ["webDecodeBooleanText", 'must be "true" or "false"'],
    date: ["webDecodeDateText", "must be a date"],
  } as const;
  const [decoder, message] = decoderByScalar[shape.scalar];
  return [`${target} = ${decoder}(${raw});`, `if (${target} === undefined) {`, issue(message), "}"];
}

function textArrayLines(
  element: ContractShape,
  index: number,
  label: string,
  pathText: string,
  context: TextDecodeContext,
): readonly string[] {
  // getAll 语义:缺键即空数组,数组位没有 missing。
  return [
    `const items${index}: unknown[] = [];`,
    `for (const item of raw${index}) {`,
    "  let element: unknown;",
    ...indented(textScalarLines(element, "item", "element", label, pathText, context), "  "),
    "  if (element !== undefined) {",
    `    items${index}.push(element);`,
    "  }",
    "}",
    `v${index} = items${index};`,
  ];
}

function textFieldLines(
  slot: "param" | "query" | "header",
  plan: TextFieldPlan,
  index: number,
  context: TextDecodeContext,
): readonly string[] {
  const isArray = plan.shape.kind === "array";
  const raw = `raw${index}`;
  const target = `v${index}`;
  const label = plan.path.length === 0 ? plan.key : plan.path.join(".");
  const pathText = `[${plan.path.map(quoted).join(", ")}]`;
  const lines: string[] = [
    `const ${raw} = ${rawExtraction(slot, plan.key, isArray)};`,
    `let ${target}: unknown;`,
  ];
  if (plan.shape.kind === "array") {
    lines.push(...textArrayLines(plan.shape.element, index, label, pathText, context));
    return lines;
  }
  const decode = indented(textScalarLines(plan.shape, raw, target, label, pathText, context), "  ");
  if (plan.optional) {
    lines.push(`if (${raw} !== undefined) {`, ...decode, "}");
    return lines;
  }
  lines.push(
    `if (${raw} === undefined) {`,
    `  issues.push(webSlotIssue(${quoted(`${label} must be present`)}, ${pathText}));`,
    "} else {",
    ...decode,
    "}",
  );
  return lines;
}

// 三字符串槽解码器:单键 = 一个位直取;契约 = 逐字段直写,未声明键忽略,issues 一次收齐。
export function renderStringSlotDecoder(name: string, slot: StringRouteSlotModel): string {
  const root = rootShapeOfTable(slot.table);
  const plans: TextFieldPlan[] =
    slot.form === "contract"
      ? (root.kind === "object" ? root.fields : []).map((field) => ({
          key: field.name,
          shape:
            field.shape.kind === "reference"
              ? (slot.table.definitions[field.shape.target]?.shape ?? field.shape)
              : field.shape,
          optional: field.optional,
          path: [field.name],
        }))
      : [
          {
            key: slot.key ?? "",
            shape: root,
            optional: slot.form === "optional-single",
            path: [],
          },
        ];
  const context: TextDecodeContext = { helpers: [], counter: 0 };
  const fieldLines = plans.flatMap((plan, index) => [
    ...textFieldLines(slot.kind, plan, index, context),
  ]);
  const valueLines =
    slot.form === "contract"
      ? [
          "const value: Record<string, unknown> = {};",
          ...plans.flatMap((plan, index) => [
            `if (v${index} !== undefined) {`,
            `  value[${quoted(plan.key)}] = v${index};`,
            "}",
          ]),
        ]
      : ["const value = v0;"];
  return [
    `const ${name}: StandardSchemaV1 = (() => {`,
    ...indented(context.helpers, "  "),
    "  return {",
    '    "~standard": {',
    "      version: 1,",
    '      vendor: "reforce",',
    "      validate: (input: unknown) => {",
    "        // 载体由执行链按槽位分派保证(#274 载体表)",
    `        const carrier = input as ${carrierTypes[slot.kind]};`,
    "        const issues: WebSlotIssue[] = [];",
    ...indented(fieldLines, "        "),
    ...indented(valueLines, "        "),
    "        if (issues.length > 0) {",
    "          return { issues };",
    "        }",
    "        return { value };",
    "      },",
    "    },",
    "  };",
    "})();",
  ].join("\n");
}

// ———— Body:JSON 形状解码(层②定形 + 层③逐字段) ————

interface BodyGenContext {
  readonly declarations: string[];
  readonly definitionNames: ReadonlyMap<string, string>;
  counter: number;
}

function bodyIssue(what: string): string {
  return `issues.push(webSlotIssue(\`\${webPathText(path)} ${what}\`, path));`;
}

// 各形状的函数体(零缩进;结尾统一由组装方补 return undefined)。
function bodyScalarBody(
  scalar: "string" | "number" | "bigint" | "boolean" | "date" | "null",
): readonly string[] {
  if (scalar === "bigint" || scalar === "date") {
    const decoder = scalar === "bigint" ? "webDecodeBigIntJson" : "webDecodeDateJson";
    const message = scalar === "bigint" ? "must be an integer" : "must be a date string";
    return [
      `const parsed = ${decoder}(raw);`,
      "if (parsed !== undefined) {",
      "  return parsed;",
      "}",
      bodyIssue(message),
    ];
  }
  if (scalar === "null") {
    return ["if (raw === null) {", "  return null;", "}", bodyIssue("must be null")];
  }
  return [
    `if (typeof raw === ${quoted(scalar)}) {`,
    "  return raw;",
    "}",
    bodyIssue(`must be a ${scalar}`),
  ];
}

function bodyLiteralBody(
  shape: Extract<ContractShape, { readonly kind: "literal" }>,
): readonly string[] {
  const direct = shape.values.filter((value) => value.scalar !== "bigint");
  const bigints = shape.values.filter((value) => value.scalar === "bigint");
  const lines: string[] = [];
  if (direct.length > 0) {
    const condition = direct.map((value) => `raw === ${literalText(value)}`).join(" || ");
    lines.push(`if (${condition}) {`, "  return raw;", "}");
  }
  for (const value of bigints) {
    lines.push(
      `if (webDecodeBigIntJson(raw) === ${literalText(value)}) {`,
      `  return ${literalText(value)};`,
      "}",
    );
  }
  const allowed = shape.values.map((value) => String(value.value)).join(", ");
  lines.push(bodyIssue(`must be one of: ${allowed}`));
  return lines;
}

function bodyObjectBody(
  shape: Extract<ContractShape, { readonly kind: "object" }>,
  context: BodyGenContext,
): readonly string[] {
  const lines: string[] = [
    "if (!webIsPlainObject(raw)) {",
    `  ${bodyIssue("must be an object")}`,
    "  return undefined;",
    "}",
    "const result: Record<string, unknown> = {};",
  ];
  for (const field of shape.fields) {
    const fieldFn = bodyShapeFunction(field.shape, context);
    const key = quoted(field.name);
    const decodePresent = [
      `  const decoded = ${fieldFn}(raw[${key}], [...path, ${key}], issues);`,
      "  if (decoded !== undefined) {",
      `    result[${key}] = decoded;`,
      "  }",
    ];
    if (field.optional) {
      lines.push(`if (raw[${key}] !== undefined) {`, ...decodePresent, "}");
      continue;
    }
    lines.push(
      `if (raw[${key}] === undefined) {`,
      `  issues.push(webSlotIssue(\`\${webPathText([...path, ${key}])} must be present\`, [...path, ${key}]));`,
      "} else {",
      ...decodePresent,
      "}",
    );
  }
  lines.push("return result;");
  return lines;
}

function bodyUnionBody(
  shape: Extract<ContractShape, { readonly kind: "union" }>,
  context: BodyGenContext,
): readonly string[] {
  const discriminant = quoted(shape.discriminant);
  const lines: string[] = [
    "if (!webIsPlainObject(raw)) {",
    `  ${bodyIssue("must be an object")}`,
    "  return undefined;",
    "}",
    `const tag = raw[${discriminant}];`,
  ];
  for (const member of shape.members) {
    const memberFn = bodyShapeFunction(member.shape, context);
    lines.push(
      `if (tag === ${literalText(member.tag)}) {`,
      `  return ${memberFn}(raw, path, issues);`,
      "}",
    );
  }
  const allowed = shape.members.map((member) => String(member.tag.value)).join(", ");
  lines.push(
    `issues.push(webSlotIssue(\`\${webPathText([...path, ${discriminant}])} must be one of: ${allowed}\`, [...path, ${discriminant}]));`,
  );
  return lines;
}

function bodyArrayBody(
  shape: Extract<ContractShape, { readonly kind: "array" }>,
  context: BodyGenContext,
): readonly string[] {
  const elementFn = bodyShapeFunction(shape.element, context);
  return [
    "if (!Array.isArray(raw)) {",
    `  ${bodyIssue("must be an array")}`,
    "  return undefined;",
    "}",
    "const items: unknown[] = [];",
    "for (const [index, item] of raw.entries()) {",
    `  items.push(${elementFn}(item, [...path, index], issues));`,
    "}",
    "return items;",
  ];
}

function bodyShapeBody(shape: ContractShape, context: BodyGenContext): readonly string[] {
  switch (shape.kind) {
    case "scalar":
      return bodyScalarBody(shape.scalar);
    case "literal":
      return bodyLiteralBody(shape);
    case "object":
      return bodyObjectBody(shape, context);
    case "array":
      return bodyArrayBody(shape, context);
    case "union":
      return bodyUnionBody(shape, context);
    case "reference":
      // reference 在 bodyShapeFunction 处直连定义函数,不会走到这里。
      throw new Error("Unexpected reference shape in body decoder generation.");
  }
}

function declareBodyFunction(name: string, shape: ContractShape, context: BodyGenContext): void {
  const nullGuard = shape.nullable ? ["if (raw === null) {", "  return null;", "}"] : [];
  const body = shape.kind === "reference" ? [] : bodyShapeBody(shape, context);
  context.declarations.push(
    [
      `  const ${name} = (raw: unknown, path: readonly (string | number)[], issues: WebSlotIssue[]): unknown => {`,
      ...indented([...nullGuard, ...body], "    "),
      "    return undefined;",
      "  };",
    ].join("\n"),
  );
}

function bodyShapeFunction(shape: ContractShape, context: BodyGenContext): string {
  if (shape.kind === "reference") {
    const definitionName = context.definitionNames.get(shape.target);
    if (definitionName === undefined) {
      throw new Error(`Missing contract definition ${shape.target} in body decoder generation.`);
    }
    if (!shape.nullable) {
      return definitionName;
    }
    // nullable 引用:薄包一层处理 null 后直连定义函数。
    const name = `decode${context.counter}`;
    context.counter += 1;
    context.declarations.push(
      [
        `  const ${name} = (raw: unknown, path: readonly (string | number)[], issues: WebSlotIssue[]): unknown => {`,
        "    if (raw === null) {",
        "      return null;",
        "    }",
        `    return ${definitionName}(raw, path, issues);`,
        "  };",
      ].join("\n"),
    );
    return name;
  }
  const name = `decode${context.counter}`;
  context.counter += 1;
  declareBodyFunction(name, shape, context);
  return name;
}

// Body 解码器:层②定形按契约根形态(对象/数组/标量),层③逐字段;递归契约经 definitions
// 具名函数闭合(先占名再生成体,环按名字直连,调用发生在 IIFE 完成初始化之后)。
export function renderBodyDecoder(name: string, slot: BodyRouteSlotModel): string {
  const definitionKeys = Object.keys(slot.table.definitions);
  const definitionNames = new Map(definitionKeys.map((key, index) => [key, `decodeDef${index}`]));
  const context: BodyGenContext = { declarations: [], definitionNames, counter: 0 };
  for (const key of definitionKeys) {
    const definition = slot.table.definitions[key];
    const fnName = definitionNames.get(key);
    if (definition !== undefined && fnName !== undefined) {
      declareBodyFunction(fnName, definition.shape, context);
    }
  }
  const rootFn = bodyShapeFunction(slot.table.root, context);
  return [
    `const ${name}: StandardSchemaV1 = (() => {`,
    ...context.declarations,
    "  return {",
    '    "~standard": {',
    "      version: 1,",
    '      vendor: "reforce",',
    "      validate: (input: unknown) => {",
    "        const issues: WebSlotIssue[] = [];",
    `        const value = ${rootFn}(input, [], issues);`,
    "        if (issues.length > 0) {",
    "          return { issues };",
    "        }",
    "        return { value };",
    "      },",
    "    },",
    "  };",
    "})();",
  ].join("\n");
}
