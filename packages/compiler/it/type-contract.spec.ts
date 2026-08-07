import { afterEach, describe, expect, test } from "vitest";
import {
  type ContractTable,
  expandTypeContract,
  type TypeContractResult,
} from "@/analysis/type-contract";
import type { CanonicalFileId, SourceSpan } from "@/parser/source-location";
import { type CheckerHarness, createCheckerHarness } from "./support/checker-project";

// 字段表对真 checker 的语义对照(RFC 0012 S1,#273):工具类型、enum、Date 双声明、内置容器
// 这些 stub 表达不了的形态在这里钉住;算法分支覆盖在 test/analysis/type-contract.spec.ts。

let harness: CheckerHarness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

function span(): SourceSpan {
  return {
    fileId: "src/contracts.ts" as CanonicalFileId, // justified: 相对路径满足 canonical 文法
    start: { offset: 0, line: 0, character: 0 },
    end: { offset: 1, line: 0, character: 1 },
  };
}

async function expandAtToken(
  sources: Readonly<Record<string, string>>,
  token: string,
  nth = 0,
): Promise<TypeContractResult> {
  harness = await createCheckerHarness(sources);
  const lease = harness.lease();
  const file = harness.filePath("src/contracts.ts");
  const [type] = lease.query.getTypesAtPositions(file, [
    harness.offsetOf("src/contracts.ts", token, nth),
  ]);
  if (type === undefined) {
    throw new Error(`No type at token: ${token}`);
  }
  return expandTypeContract({
    type,
    span: span(),
    query: lease.query,
    fileIdOf: harness.fileIdOf,
  });
}

function tableOf(result: TypeContractResult): ContractTable {
  expect(result.diagnostics).toEqual([]);
  if (result.table === undefined) {
    throw new Error("Expected a contract table");
  }
  return result.table;
}

describe("utility type instantiation", () => {
  test("Omit and nested Partial/Pick expand to plain fields with synthetic optionality", async () => {
    const result = await expandAtToken(
      {
        "contracts.ts": [
          "export interface Address { city: string; zip?: string }",
          "export interface User { id: number; name: string; address: Address; secret: string }",
          'export type PublicUser = Omit<User, "secret">;',
          'export type UserPatch = Partial<Pick<User, "name" | "id">>;',
          "export interface Wrap { user: PublicUser; patch: UserPatch }",
        ].join("\n"),
      },
      "Wrap",
    );

    const table = tableOf(result);
    // UserPatch 不出现在 definitions:`type X = Partial<…>` 的实例化在 checker 里挂的
    // aliasSymbol 是 lib 的 Partial(带实参),不是项目别名 X,于是按 lib alias 实例化内联;
    // Omit 展开后的 PublicUser 挂的才是项目别名,照常提升。
    expect(Object.keys(table.definitions)).toEqual([
      "src/contracts.ts#Address",
      "src/contracts.ts#PublicUser",
      "src/contracts.ts#Wrap",
    ]);
    expect(table.definitions["src/contracts.ts#PublicUser"]?.shape).toEqual({
      kind: "object",
      nullable: false,
      fields: [
        {
          name: "address",
          optional: false,
          shape: { kind: "reference", target: "src/contracts.ts#Address", nullable: false },
        },
        {
          name: "id",
          optional: false,
          shape: { kind: "scalar", scalar: "number", nullable: false },
        },
        {
          name: "name",
          optional: false,
          shape: { kind: "scalar", scalar: "string", nullable: false },
        },
      ],
    });
    // Partial 的合成 symbol 带 Optional flag,undefined 剥进 optional;形状内联在使用位。
    const wrapShape = table.definitions["src/contracts.ts#Wrap"]?.shape;
    expect(wrapShape?.kind === "object" ? wrapShape.fields[0]?.shape : undefined).toEqual({
      kind: "object",
      nullable: false,
      fields: [
        {
          name: "id",
          optional: true,
          shape: { kind: "scalar", scalar: "number", nullable: false },
        },
        {
          name: "name",
          optional: true,
          shape: { kind: "scalar", scalar: "string", nullable: false },
        },
      ],
    });
  });

  test("an instantiated conditional type matches its handwritten equivalent", async () => {
    const result = await expandAtToken(
      {
        "contracts.ts": [
          "export type Cond<T> = T extends string ? { s: string } : { n: number };",
          "export interface Holder { picked: Cond<string> }",
        ].join("\n"),
      },
      "Holder",
    );

    const table = tableOf(result);
    expect(table.definitions["src/contracts.ts#Holder"]?.shape).toEqual({
      kind: "object",
      nullable: false,
      fields: [
        {
          name: "picked",
          optional: false,
          shape: {
            kind: "object",
            nullable: false,
            fields: [
              {
                name: "s",
                optional: false,
                shape: { kind: "scalar", scalar: "string", nullable: false },
              },
            ],
          },
        },
      ],
    });
  });
});

describe("booleans and enums", () => {
  test("boolean, true literal, and all three enum kinds classify as scalars and literals", async () => {
    const result = await expandAtToken(
      {
        "contracts.ts": [
          "export enum Level { Low = 1, High = 2 }",
          'export enum Mode { A = "a", B = "b" }',
          "export const enum Flag { On = 1 }",
          "export interface WithEnums { ok: boolean; yes: true; level: Level; mode: Mode; flag: Flag }",
        ].join("\n"),
      },
      "WithEnums",
    );

    const table = tableOf(result);
    expect(table.definitions["src/contracts.ts#WithEnums"]?.shape).toEqual({
      kind: "object",
      nullable: false,
      fields: [
        {
          name: "flag",
          optional: false,
          shape: { kind: "literal", nullable: false, values: [{ scalar: "number", value: 1 }] },
        },
        {
          name: "level",
          optional: false,
          shape: {
            kind: "literal",
            nullable: false,
            values: [
              { scalar: "number", value: 1 },
              { scalar: "number", value: 2 },
            ],
          },
        },
        {
          name: "mode",
          optional: false,
          shape: {
            kind: "literal",
            nullable: false,
            values: [
              { scalar: "string", value: "a" },
              { scalar: "string", value: "b" },
            ],
          },
        },
        {
          name: "ok",
          optional: false,
          shape: { kind: "scalar", scalar: "boolean", nullable: false },
        },
        {
          name: "yes",
          optional: false,
          shape: { kind: "literal", nullable: false, values: [{ scalar: "boolean", value: true }] },
        },
      ],
    });
  });
});

describe("built-in types", () => {
  test("Date passes as a scalar while a Date subclass is a class violation", async () => {
    const okResult = await expandAtToken(
      { "contracts.ts": "export interface WithDate { at: Date }" },
      "WithDate",
    );
    const table = tableOf(okResult);
    expect(table.definitions["src/contracts.ts#WithDate"]?.shape).toEqual({
      kind: "object",
      nullable: false,
      fields: [
        { name: "at", optional: false, shape: { kind: "scalar", scalar: "date", nullable: false } },
      ],
    });
    await harness?.cleanup();
    harness = undefined;

    const badResult = await expandAtToken(
      {
        "contracts.ts": [
          "export class MyDate extends Date {}",
          "export interface WithMyDate { at: MyDate }",
        ].join("\n"),
      },
      "WithMyDate",
    );
    expect(badResult.table).toBeUndefined();
    expect(badResult.diagnostics.map((item) => item.code)).toEqual(["CONTRACT_CLASS_TYPE"]);
  });

  test("built-in containers are rejected one diagnostic per field", async () => {
    const result = await expandAtToken(
      {
        "contracts.ts": [
          "export interface WithContainers {",
          "  s: Set<number>;",
          "  m: Map<string, number>;",
          "  u: Uint8Array;",
          "}",
        ].join("\n"),
      },
      "WithContainers",
    );

    expect(result.table).toBeUndefined();
    expect(result.diagnostics.map((item) => item.code)).toEqual([
      "INVALID_CONTRACT_TYPE",
      "INVALID_CONTRACT_TYPE",
      "INVALID_CONTRACT_TYPE",
    ]);
  });

  test("Record types are index signature violations", async () => {
    const result = await expandAtToken(
      { "contracts.ts": "export interface WithRecord { extra: Record<string, number> }" },
      "WithRecord",
    );

    expect(result.table).toBeUndefined();
    expect(result.diagnostics.map((item) => item.code)).toEqual(["CONTRACT_INDEX_SIGNATURE"]);
  });

  test("an undiscriminated object union is rejected", async () => {
    const result = await expandAtToken(
      {
        "contracts.ts": [
          "export interface Left { a: string }",
          "export interface Right { b: number }",
          "export interface Holder { either: Left | Right }",
        ].join("\n"),
      },
      "Holder",
    );

    expect(result.table).toBeUndefined();
    expect(result.diagnostics.map((item) => item.code)).toEqual([
      "CONTRACT_UNION_NOT_DISCRIMINATED",
    ]);
  });
});

describe("recursive contracts", () => {
  test("a directly recursive interface closes through its definition", async () => {
    const result = await expandAtToken(
      {
        "contracts.ts": "export interface Category { name: string; children: Category[] }",
      },
      "Category",
    );

    const table = tableOf(result);
    expect(table.root).toEqual({
      kind: "reference",
      target: "src/contracts.ts#Category",
      nullable: false,
    });
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

  test("an indirect cycle across files keys definitions by declaring file", async () => {
    const result = await expandAtToken(
      {
        "contracts.ts": [
          'import type { NodeB } from "./other";',
          "export interface NodeA { b: NodeB | null }",
        ].join("\n"),
        "other.ts": [
          'import type { NodeA } from "./contracts";',
          "export interface NodeB { a: NodeA[] }",
        ].join("\n"),
      },
      "NodeA",
    );

    const table = tableOf(result);
    expect(Object.keys(table.definitions)).toEqual([
      "src/contracts.ts#NodeA",
      "src/other.ts#NodeB",
    ]);
    expect(table.definitions["src/contracts.ts#NodeA"]?.shape).toEqual({
      kind: "object",
      nullable: false,
      fields: [
        {
          name: "b",
          optional: false,
          shape: { kind: "reference", target: "src/other.ts#NodeB", nullable: true },
        },
      ],
    });
  });

  test("a lib alias over a recursive type inlines while the project type still promotes", async () => {
    const result = await expandAtToken(
      {
        "contracts.ts": [
          "export interface TreeNode { name: string; next?: TreeNode }",
          "export interface Holder { patch: Partial<TreeNode> }",
        ].join("\n"),
      },
      "Holder",
    );

    const table = tableOf(result);
    // Partial<TreeNode> 是 lib alias 实例化:不提升、内联展开;其中的 TreeNode 照常提升闭环。
    expect(Object.keys(table.definitions)).toEqual([
      "src/contracts.ts#Holder",
      "src/contracts.ts#TreeNode",
    ]);
    expect(table.definitions["src/contracts.ts#Holder"]?.shape).toEqual({
      kind: "object",
      nullable: false,
      fields: [
        {
          name: "patch",
          optional: false,
          shape: {
            kind: "object",
            nullable: false,
            fields: [
              {
                name: "name",
                optional: true,
                shape: { kind: "scalar", scalar: "string", nullable: false },
              },
              {
                name: "next",
                optional: true,
                shape: {
                  kind: "reference",
                  target: "src/contracts.ts#TreeNode",
                  nullable: false,
                },
              },
            ],
          },
        },
      ],
    });
  });
});

describe("full contract", () => {
  test("readonly arrays, optionality, discriminated unions, and recursion compose", async () => {
    const result = await expandAtToken(
      {
        "contracts.ts": [
          "export interface Comment { author: string; replies: readonly Comment[] }",
          'export interface TextBlock { kind: "text"; text: string }',
          'export interface LinkBlock { kind: "link"; href: string; label?: string }',
          "export type Block = TextBlock | LinkBlock;",
          "export interface Article {",
          "  title: string;",
          "  publishedAt: Date | null;",
          "  tags: readonly string[];",
          "  blocks: Block[];",
          "  topComment?: Comment;",
          "}",
        ].join("\n"),
      },
      "Article",
    );

    const table = tableOf(result);
    expect(table.root).toEqual({
      kind: "reference",
      target: "src/contracts.ts#Article",
      nullable: false,
    });
    expect(Object.keys(table.definitions)).toEqual([
      "src/contracts.ts#Article",
      "src/contracts.ts#Block",
      "src/contracts.ts#Comment",
      "src/contracts.ts#LinkBlock",
      "src/contracts.ts#TextBlock",
    ]);
    expect(table.definitions["src/contracts.ts#Article"]?.shape).toEqual({
      kind: "object",
      nullable: false,
      fields: [
        {
          name: "blocks",
          optional: false,
          shape: {
            kind: "array",
            nullable: false,
            element: { kind: "reference", target: "src/contracts.ts#Block", nullable: false },
          },
        },
        {
          name: "publishedAt",
          optional: false,
          shape: { kind: "scalar", scalar: "date", nullable: true },
        },
        {
          name: "tags",
          optional: false,
          shape: {
            kind: "array",
            nullable: false,
            element: { kind: "scalar", scalar: "string", nullable: false },
          },
        },
        {
          name: "title",
          optional: false,
          shape: { kind: "scalar", scalar: "string", nullable: false },
        },
        {
          name: "topComment",
          optional: true,
          shape: { kind: "reference", target: "src/contracts.ts#Comment", nullable: false },
        },
      ],
    });
    expect(table.definitions["src/contracts.ts#Block"]?.shape).toEqual({
      kind: "union",
      discriminant: "kind",
      nullable: false,
      members: [
        {
          tag: { scalar: "string", value: "link" },
          shape: { kind: "reference", target: "src/contracts.ts#LinkBlock", nullable: false },
        },
        {
          tag: { scalar: "string", value: "text" },
          shape: { kind: "reference", target: "src/contracts.ts#TextBlock", nullable: false },
        },
      ],
    });
  });
});
