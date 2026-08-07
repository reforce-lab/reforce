import { describe, expect, test } from "vitest";
import type { RouteContractModel, StringRouteSlotModel } from "@/analysis/web-model";
import {
  type AnnotationHeadSymbol,
  findSchemaTypeQuery,
  reportUnknownPathParameters,
  resolveRouteSlots,
  type SchemaTraceScope,
  type SlotResolutionContext,
  stringSlotShapeOf,
} from "@/analysis/web-slots";
import type { CompilerDiagnostic } from "@/api";
import type {
  ClassMethodDeclaration,
  EntityName,
  MethodParameter,
  TypeNode,
} from "@/parser/source-ir";
import type { ParsedSource } from "@/project/source-files";
import { canonicalFileId, span } from "./support/ir";
import {
  anonymousObject,
  array,
  createStubQuery,
  intrinsic,
  literal,
  namedObject,
  property,
  type StubProperty,
  type StubType,
  stringLiteral,
  union,
} from "./support/type-contract-stub";

// 槽位解析算法单测(RFC 0012 S2,#274):四种写法、六类硬错、七种追溯形态的语法走查、
// 槽位差异与无 checker 口径,全部吃 type-contract-stub,不起 tsgo。

const file = "src/users-controller.ts";

const sp = (offset = 0) => span(file, offset);

// ———— TypeNode 便签 ————

const ident = (name: string, offset = 0): EntityName => ({
  kind: "identifier",
  name,
  span: sp(offset),
});

const qualified = (left: string, right: string): EntityName => ({
  kind: "qualified",
  left: ident(left),
  right,
  span: sp(),
});

const ref = (name: EntityName | string, typeArguments: readonly TypeNode[] = []): TypeNode => ({
  kind: "reference",
  name: typeof name === "string" ? ident(name) : name,
  typeArguments,
  span: sp(),
});

const strLit = (value: string): TypeNode => ({ kind: "string-literal", value, span: sp() });

const prim = (
  name: "void" | "string" | "number" | "bigint" | "boolean" | "undefined",
): TypeNode => ({ kind: "primitive", name, span: sp() });

const unionNode = (members: readonly TypeNode[]): TypeNode => ({
  kind: "union",
  members,
  span: sp(),
});

const typeQueryNode = (name: EntityName | string): TypeNode => ({
  kind: "type-query",
  name: typeof name === "string" ? ident(name) : name,
  span: sp(),
});

const arrayNode = (element: TypeNode): TypeNode => ({
  kind: "array",
  element,
  readonlyModifier: false,
  span: sp(),
});

// ———— 方法/参数便签 ————

function parameter(index: number, name: string, annotation?: TypeNode): MethodParameter {
  const offset = 100 + index * 10;
  return {
    kind: "method-parameter",
    index,
    name,
    nameSpan: sp(offset),
    ...(annotation === undefined ? {} : { typeAnnotation: annotation }),
    optional: false,
    rest: false,
    hasInitializer: false,
    span: sp(offset),
  };
}

function methodOf(
  parameters: readonly MethodParameter[],
  returnType?: TypeNode,
): ClassMethodDeclaration {
  return {
    kind: "method",
    name: { kind: "identifier", name: "show", span: sp(90) },
    static: false,
    accessibility: "public",
    async: false,
    generator: false,
    optional: false,
    implementation: true,
    parameters,
    ...(returnType === undefined ? {} : { returnType }),
    decorators: [],
    span: sp(80),
  };
}

// ———— 上下文替身 ————

const dummySource: ParsedSource = {
  absolutePath: "/app/src/web-schemas.ts",
  fileId: canonicalFileId("src/web-schemas.ts"),
  sourceKind: "ts",
  unit: {
    suppressions: [],
    imports: [],
    exports: [],
    interfaces: [],
    namespaces: [],
    classes: [],
    beanFactories: [],
    applicationDefinitions: [],
    configFactoryCalls: [],
    valueDeclarations: [],
    unsupportedDeclarations: [],
  },
};

const defaultHeads: Record<string, AnnotationHeadSymbol> = {
  Body: { kind: "web", name: "Body" },
  Param: { kind: "web", name: "Param" },
  Query: { kind: "web", name: "Query" },
  Header: { kind: "web", name: "Header" },
  RequestContext: { kind: "web", name: "RequestContext" },
  Middleware: { kind: "web", name: "Middleware" },
  Request: { kind: "global", name: "Request" },
  Headers: { kind: "global", name: "Headers" },
  Response: { kind: "global", name: "Response" },
  Promise: { kind: "global", name: "Promise" },
};

interface ScopeOptions {
  readonly aliases?: Record<string, { readonly rhs: TypeNode; readonly scope?: ScopeOptions }>;
  readonly schemaValues?: Record<string, StubType | undefined>;
}

function scopeOf(options: ScopeOptions): SchemaTraceScope<StubType> {
  return {
    aliasRhsOf: (name) => {
      const key = name.kind === "identifier" ? name.name : undefined;
      const entry = key === undefined ? undefined : options.aliases?.[key];
      if (entry === undefined) {
        return undefined;
      }
      return { rhs: entry.rhs, ...scopeOf(entry.scope ?? options) };
    },
    schemaTargetOf: (name) => {
      const key = name.kind === "identifier" ? name.name : leftmostOf(name);
      if (options.schemaValues === undefined || !(key in options.schemaValues)) {
        return undefined;
      }
      return {
        ref: { source: dummySource, exportName: key },
        type: options.schemaValues[key],
      };
    },
  };
}

function leftmostOf(name: EntityName): string {
  return name.kind === "identifier" ? name.name : leftmostOf(name.left);
}

interface HarnessOptions extends ScopeOptions {
  readonly withQuery?: boolean;
  readonly parameterTypes?: Record<string, StubType>;
  readonly methodType?: StubType;
  readonly declarationTypes?: Record<string, StubType>;
  readonly heads?: Record<string, AnnotationHeadSymbol>;
}

function contextOf(options: HarnessOptions = {}): {
  readonly context: SlotResolutionContext<StubType, StubProperty>;
  readonly diagnostics: CompilerDiagnostic[];
} {
  const diagnostics: CompilerDiagnostic[] = [];
  const scope = scopeOf(options);
  const heads = { ...defaultHeads, ...options.heads };
  return {
    diagnostics,
    context: {
      query: options.withQuery === false ? undefined : createStubQuery(),
      fileIdOf: (declarationPath) =>
        declarationPath.startsWith("/app/") ? declarationPath.slice("/app/".length) : undefined,
      typeAtParameter: (item) =>
        item.name === undefined ? undefined : options.parameterTypes?.[item.name],
      typeAtMethodName: () => options.methodType,
      headSymbolOf: (name) => {
        const key = name.kind === "identifier" ? name.name : undefined;
        return (key === undefined ? undefined : heads[key]) ?? { kind: "other" };
      },
      contractDeclarationTypeOf: (reference) => {
        const key = reference.name.kind === "identifier" ? reference.name.name : undefined;
        return key === undefined ? undefined : options.declarationTypes?.[key];
      },
      aliasRhsOf: scope.aliasRhsOf,
      schemaTargetOf: scope.schemaTargetOf,
      diagnostics,
    },
  };
}

function resolveWith(
  parameters: readonly MethodParameter[],
  options: HarnessOptions = {},
  returnType?: TypeNode,
): {
  readonly contract: RouteContractModel | undefined;
  readonly diagnostics: CompilerDiagnostic[];
} {
  const { context, diagnostics } = contextOf(options);
  const contract = resolveRouteSlots({
    method: methodOf(parameters, returnType),
    controllerName: "Users",
    context,
  });
  return { contract, diagnostics };
}

function codesOf(diagnostics: readonly CompilerDiagnostic[]): readonly string[] {
  return diagnostics.map((item) => item.code);
}

const snowflakeContract = namedObject("SnowflakeParams", [
  property("id", intrinsic("bigint")),
  property("orgId", intrinsic("bigint")),
]);

const createUserContract = namedObject("CreateUser", [
  property("age", intrinsic("number")),
  property("name", intrinsic("string")),
]);

const standardSchemaValue = (vendor = "zod"): StubType =>
  anonymousObject([
    property(
      "~standard",
      anonymousObject([
        property("version", literal({ kind: "number", value: 1 })),
        property("vendor", stringLiteral(vendor)),
        property("validate", { kind: "function" }),
      ]),
    ),
  ]);

// ———— 形态裁决(纯语法) ————

describe("stringSlotShapeOf", () => {
  test("classifies a string literal as a single key", () => {
    expect(stringSlotShapeOf(strLit("id"))).toEqual({ form: "single", key: "id" });
  });

  test("classifies key-union-undefined as an optional single key", () => {
    expect(stringSlotShapeOf(unionNode([strLit("x-tenant"), prim("undefined")]))).toEqual({
      form: "optional-single",
      key: "x-tenant",
    });
  });

  test("classifies two literals as a literal-union misuse", () => {
    expect(stringSlotShapeOf(unionNode([strLit("a"), strLit("b")])).form).toBe("literal-union");
  });

  test("classifies a literal mixed into a non-literal union as a literal-union misuse", () => {
    expect(stringSlotShapeOf(unionNode([strLit("a"), prim("number")])).form).toBe("literal-union");
  });

  test("classifies bare string and bare scalars separately", () => {
    expect(stringSlotShapeOf(prim("string")).form).toBe("bare-string");
    expect(stringSlotShapeOf(prim("bigint"))).toEqual({ form: "bare-scalar", scalar: "bigint" });
  });

  test("classifies references and unions of references as contract form", () => {
    expect(stringSlotShapeOf(ref("SnowflakeParams")).form).toBe("contract");
    expect(stringSlotShapeOf(unionNode([ref("A"), ref("B")])).form).toBe("contract");
  });
});

// ———— 四种写法 ————

describe("resolveRouteSlots forms", () => {
  test("resolves a single key with its default string value", () => {
    const { contract, diagnostics } = resolveWith(
      [parameter(0, "id", ref("Param", [strLit("id")]))],
      { parameterTypes: { id: intrinsic("string") } },
    );

    expect(diagnostics).toEqual([]);
    expect(contract?.slots).toMatchObject([
      {
        kind: "param",
        form: "single",
        key: "id",
        table: { root: { kind: "scalar", scalar: "string" } },
      },
    ]);
  });

  test("resolves a single key with an explicit bigint value", () => {
    const { contract, diagnostics } = resolveWith(
      [parameter(0, "id", ref("Param", [strLit("id"), prim("bigint")]))],
      { parameterTypes: { id: intrinsic("bigint") } },
    );

    expect(diagnostics).toEqual([]);
    expect(contract?.slots[0]).toMatchObject({
      kind: "param",
      form: "single",
      key: "id",
      table: { root: { kind: "scalar", scalar: "bigint" } },
      contractSource: { source: "type" },
    });
  });

  test("resolves an optional single key written as key-union-undefined", () => {
    const { contract, diagnostics } = resolveWith(
      [parameter(0, "tenant", ref("Header", [unionNode([strLit("x-tenant"), prim("undefined")])]))],
      { parameterTypes: { tenant: union([intrinsic("string"), intrinsic("undefined")]) } },
    );

    expect(diagnostics).toEqual([]);
    expect(contract?.slots[0]).toMatchObject({
      kind: "header",
      form: "optional-single",
      key: "x-tenant",
    });
  });

  test("resolves an optional single key written as an optional value type", () => {
    const { contract, diagnostics } = resolveWith(
      [
        parameter(
          0,
          "page",
          ref("Query", [strLit("page"), unionNode([prim("number"), prim("undefined")])]),
        ),
      ],
      { parameterTypes: { page: union([intrinsic("number"), intrinsic("undefined")]) } },
    );

    expect(diagnostics).toEqual([]);
    expect(contract?.slots[0]).toMatchObject({
      kind: "query",
      form: "optional-single",
      key: "page",
    });
  });

  test("resolves a Query single key holding a scalar array", () => {
    const { contract, diagnostics } = resolveWith(
      [parameter(0, "tags", ref("Query", [strLit("tag"), arrayNode(prim("string"))]))],
      { parameterTypes: { tags: array(intrinsic("string")) } },
    );

    expect(diagnostics).toEqual([]);
    expect(contract?.slots[0]).toMatchObject({ kind: "query", form: "single", key: "tag" });
  });

  test("resolves a contract form from the parameter type", () => {
    const { contract, diagnostics } = resolveWith(
      [parameter(0, "params", ref("Param", [ref("SnowflakeParams")]))],
      { parameterTypes: { params: snowflakeContract } },
    );

    expect(diagnostics).toEqual([]);
    const slot = contract?.slots[0] as StringRouteSlotModel;
    expect(slot).toMatchObject({ kind: "param", form: "contract" });
    expect(slot.key).toBeUndefined();
    expect(Object.keys(slot.table.definitions)).toEqual(["src/contracts.ts#SnowflakeParams"]);
  });

  test("resolves a projection from the contract declaration, not the parameter type", () => {
    const { contract, diagnostics } = resolveWith(
      [parameter(0, "id", ref("Param", [ref("SnowflakeParams"), strLit("id")]))],
      {
        // 参数名位是投影后的字段类型;整契约必须来自声明位。
        parameterTypes: { id: intrinsic("bigint") },
        declarationTypes: { SnowflakeParams: snowflakeContract },
      },
    );

    expect(diagnostics).toEqual([]);
    expect(contract?.slots[0]).toMatchObject({ kind: "param", form: "contract", key: "id" });
  });

  test("resolves a Body contract and a Body projection", () => {
    const body = resolveWith([parameter(0, "body", ref("Body", [ref("CreateUser")]))], {
      parameterTypes: { body: createUserContract },
    });
    const projected = resolveWith(
      [parameter(0, "name", ref("Body", [ref("CreateUser"), strLit("name")]))],
      {
        parameterTypes: { name: intrinsic("string") },
        declarationTypes: { CreateUser: createUserContract },
      },
    );

    expect(body.diagnostics).toEqual([]);
    expect(body.contract?.slots[0]).toMatchObject({ kind: "body" });
    expect(projected.diagnostics).toEqual([]);
    expect(projected.contract?.slots[0]).toMatchObject({ kind: "body", key: "name" });
  });

  test("accepts scalar and array roots for Body", () => {
    const scalarBody = resolveWith([parameter(0, "ok", ref("Body", [strLit("ok")]))], {
      parameterTypes: { ok: literal({ kind: "string", value: "ok" }) },
    });
    const arrayBody = resolveWith(
      [parameter(0, "items", ref("Body", [arrayNode(ref("CreateUser"))]))],
      { parameterTypes: { items: array(createUserContract) } },
    );

    expect(scalarBody.diagnostics).toEqual([]);
    expect(scalarBody.contract?.slots[0]).toMatchObject({
      kind: "body",
      table: { root: { kind: "literal" } },
    });
    expect(arrayBody.diagnostics).toEqual([]);
    expect(arrayBody.contract?.slots[0]).toMatchObject({
      kind: "body",
      table: { root: { kind: "array" } },
    });
  });

  test("resolves bare Request, RequestContext and Headers slots without any checker query", () => {
    const { contract, diagnostics } = resolveWith(
      [
        parameter(0, "request", ref("Request")),
        parameter(1, "context", ref("RequestContext")),
        parameter(2, "headers", ref("Headers")),
      ],
      { withQuery: false },
    );

    expect(diagnostics).toEqual([]);
    expect(contract?.slots.map((slot) => slot.kind)).toEqual([
      "request",
      "requestContext",
      "responseHeaders",
    ]);
  });

  test("resolves a zero-parameter handler to an empty slot list", () => {
    const { contract, diagnostics } = resolveWith([], { withQuery: false });

    expect(diagnostics).toEqual([]);
    expect(contract?.slots).toEqual([]);
    expect(contract?.response).toEqual({ kind: "passthrough" });
  });
});

// ———— 硬错 1-5 与标注集合 ————

describe("resolveRouteSlots hard errors", () => {
  test("rejects bare string as a key (hard error 1)", () => {
    const { contract, diagnostics } = resolveWith([
      parameter(0, "id", ref("Param", [prim("string")])),
    ]);

    expect(contract).toBeUndefined();
    expect(codesOf(diagnostics)).toEqual(["INVALID_SLOT_KEY"]);
  });

  test("rejects a bare scalar contract with a machine-applicable suggestion (hard error 2)", () => {
    const { contract, diagnostics } = resolveWith([
      parameter(0, "id", ref("Param", [prim("bigint")])),
    ]);

    expect(contract).toBeUndefined();
    expect(codesOf(diagnostics)).toEqual(["INVALID_SLOT_CONTRACT"]);
    expect(diagnostics[0]?.suggestions).toMatchObject([
      { replacement: 'Param<"id", bigint>', applicability: "machine-applicable" },
    ]);
  });

  test("rejects a literal union key (hard error 3)", () => {
    const { diagnostics } = resolveWith([
      parameter(0, "sort", ref("Query", [unionNode([strLit("asc"), strLit("desc")])])),
    ]);

    expect(codesOf(diagnostics)).toEqual(["INVALID_SLOT_KEY"]);
  });

  test("rejects two contracts on the same slot (hard error 4)", () => {
    const { diagnostics } = resolveWith(
      [
        parameter(0, "a", ref("Param", [ref("SnowflakeParams")])),
        parameter(1, "b", ref("Param", [ref("SnowflakeParams")])),
      ],
      { parameterTypes: { a: snowflakeContract, b: snowflakeContract } },
    );

    expect(codesOf(diagnostics)).toEqual(["CONFLICTING_SLOT_CONTRACT"]);
  });

  test("rejects mixing contract and single-key forms on one slot (hard error 4)", () => {
    const { diagnostics } = resolveWith(
      [
        parameter(0, "id", ref("Param", [strLit("id")])),
        parameter(1, "rest", ref("Param", [ref("SnowflakeParams")])),
      ],
      { parameterTypes: { id: intrinsic("string"), rest: snowflakeContract } },
    );

    expect(codesOf(diagnostics)).toEqual(["CONFLICTING_SLOT_CONTRACT"]);
  });

  test("rejects a second Body binding (hard error 4)", () => {
    const { diagnostics } = resolveWith(
      [
        parameter(0, "a", ref("Body", [ref("CreateUser")])),
        parameter(1, "b", ref("Body", [ref("CreateUser"), strLit("name")])),
      ],
      {
        parameterTypes: { a: createUserContract, b: intrinsic("string") },
        declarationTypes: { CreateUser: createUserContract },
      },
    );

    expect(codesOf(diagnostics)).toEqual(["CONFLICTING_SLOT_CONTRACT"]);
  });

  test("rejects the same single key bound twice (hard error 5)", () => {
    const { diagnostics } = resolveWith(
      [
        parameter(0, "a", ref("Query", [strLit("page")])),
        parameter(1, "b", ref("Query", [strLit("page"), prim("number")])),
      ],
      { parameterTypes: { a: intrinsic("string"), b: intrinsic("number") } },
    );

    expect(codesOf(diagnostics)).toEqual(["DUPLICATE_SLOT_BINDING"]);
  });

  test("rejects a bare annotation bound twice (hard error 5)", () => {
    const { diagnostics } = resolveWith(
      [parameter(0, "a", ref("RequestContext")), parameter(1, "b", ref("RequestContext"))],
      { withQuery: false },
    );

    expect(codesOf(diagnostics)).toEqual(["DUPLICATE_SLOT_BINDING"]);
  });

  test("rejects annotations outside the allowed set, including shadowed globals", () => {
    const cases: readonly (readonly [MethodParameter, HarnessOptions])[] = [
      [parameter(0, "user", ref("CreateUser")), {}],
      [parameter(0, "request", ref("Request")), { heads: { Request: { kind: "other" } } }],
      [parameter(0, "context", ref("RequestContext", [ref("S")])), {}],
      [parameter(0, "n"), {}],
      [
        {
          ...parameter(0, "rest", ref("Param", [strLit("id")])),
          rest: true,
        },
        {},
      ],
      [
        {
          ...parameter(0, "page", ref("Query", [strLit("page")])),
          optional: true,
        },
        {},
      ],
    ];
    for (const [item, options] of cases) {
      const { contract, diagnostics } = resolveWith([item], options);
      expect(contract).toBeUndefined();
      expect(codesOf(diagnostics)).toEqual(["INVALID_SLOT_ANNOTATION"]);
    }
  });
});

// ———— 槽位差异(checker 层产物上的裁决) ————

describe("resolveRouteSlots slot differences", () => {
  test("rejects a non-object contract root for string slots", () => {
    const { diagnostics } = resolveWith(
      [parameter(0, "items", ref("Query", [arrayNode(ref("A"))]))],
      { parameterTypes: { items: array(intrinsic("string")) } },
    );

    expect(codesOf(diagnostics)).toEqual(["INVALID_SLOT_CONTRACT"]);
  });

  test("rejects array fields in Param and Header contracts, allows them in Query", () => {
    const contractWithArray = namedObject("Filters", [
      property("tags", array(intrinsic("string"))),
    ]);
    const asParam = resolveWith([parameter(0, "p", ref("Param", [ref("Filters")]))], {
      parameterTypes: { p: contractWithArray },
    });
    const asHeader = resolveWith([parameter(0, "h", ref("Header", [ref("Filters")]))], {
      parameterTypes: { h: contractWithArray },
    });
    const asQuery = resolveWith([parameter(0, "q", ref("Query", [ref("Filters")]))], {
      parameterTypes: { q: contractWithArray },
    });

    expect(codesOf(asParam.diagnostics)).toEqual(["INVALID_SLOT_CONTRACT"]);
    expect(codesOf(asHeader.diagnostics)).toEqual(["INVALID_SLOT_CONTRACT"]);
    expect(asQuery.diagnostics).toEqual([]);
  });

  test("rejects nested object fields in string slot contracts", () => {
    const nested = namedObject("Nested", [
      property("inner", anonymousObject([property("a", intrinsic("string"))])),
    ]);
    const { diagnostics } = resolveWith([parameter(0, "q", ref("Query", [ref("Nested")]))], {
      parameterTypes: { q: nested },
    });

    expect(codesOf(diagnostics)).toEqual(["INVALID_SLOT_CONTRACT"]);
  });

  test("rejects arrays in Param single-key values", () => {
    const { diagnostics } = resolveWith(
      [parameter(0, "ids", ref("Param", [strLit("ids"), arrayNode(prim("string"))]))],
      { parameterTypes: { ids: array(intrinsic("string")) } },
    );

    expect(codesOf(diagnostics)).toEqual(["INVALID_SLOT_CONTRACT"]);
  });

  test("rejects null in single-key values", () => {
    const { diagnostics } = resolveWith(
      [parameter(0, "x", ref("Query", [strLit("x"), unionNode([prim("string"), prim("void")])]))],
      { parameterTypes: { x: union([intrinsic("string"), intrinsic("null")]) } },
    );

    expect(codesOf(diagnostics)).toEqual(["INVALID_SLOT_CONTRACT"]);
  });

  test("rejects a projection key that is not a contract field", () => {
    const { diagnostics } = resolveWith(
      [parameter(0, "id", ref("Param", [ref("SnowflakeParams"), strLit("missing")]))],
      { declarationTypes: { SnowflakeParams: snowflakeContract } },
    );

    expect(codesOf(diagnostics)).toEqual(["INVALID_SLOT_CONTRACT"]);
  });

  test("rejects a projection whose contract cannot be resolved to a declaration", () => {
    const { diagnostics } = resolveWith(
      [parameter(0, "id", ref("Param", [ref("Unknown"), strLit("id")]))],
      {},
    );

    expect(codesOf(diagnostics)).toEqual(["INVALID_SLOT_CONTRACT"]);
  });
});

// ———— 硬错 6:路径参数比对(per-route) ————

describe("reportUnknownPathParameters", () => {
  function paramContract(parameters: readonly MethodParameter[], options: HarnessOptions) {
    const { contract } = resolveWith(parameters, options);
    if (contract === undefined) {
      throw new Error("expected a resolvable contract");
    }
    return contract;
  }

  test("accepts single keys and contract fields covered by the path", () => {
    const contract = paramContract(
      [parameter(0, "params", ref("Param", [ref("SnowflakeParams")]))],
      { parameterTypes: { params: snowflakeContract } },
    );
    const diagnostics: CompilerDiagnostic[] = [];

    const valid = reportUnknownPathParameters(
      contract,
      "/users/:id/:orgId",
      new Set(["id", "orgId"]),
      diagnostics,
    );

    expect(valid).toBe(true);
    expect(diagnostics).toEqual([]);
  });

  test("rejects a single key missing from the path", () => {
    const contract = paramContract([parameter(0, "id", ref("Param", [strLit("userId")]))], {
      parameterTypes: { id: intrinsic("string") },
    });
    const diagnostics: CompilerDiagnostic[] = [];

    const valid = reportUnknownPathParameters(contract, "/users/:id", new Set(["id"]), diagnostics);

    expect(valid).toBe(false);
    expect(codesOf(diagnostics)).toEqual(["UNKNOWN_PATH_PARAMETER"]);
  });

  test("rejects contract fields the path never declares (decode runs the whole contract)", () => {
    const contract = paramContract(
      [parameter(0, "params", ref("Param", [ref("SnowflakeParams")]))],
      { parameterTypes: { params: snowflakeContract } },
    );
    const diagnostics: CompilerDiagnostic[] = [];

    const valid = reportUnknownPathParameters(contract, "/users/:id", new Set(["id"]), diagnostics);

    expect(valid).toBe(false);
    expect(codesOf(diagnostics)).toEqual(["UNKNOWN_PATH_PARAMETER"]);
  });

  test("ignores query and header slots entirely", () => {
    const contract = paramContract([parameter(0, "page", ref("Query", [strLit("page")]))], {
      parameterTypes: { page: intrinsic("string") },
    });
    const diagnostics: CompilerDiagnostic[] = [];

    expect(reportUnknownPathParameters(contract, "/users", new Set(), diagnostics)).toBe(true);
  });
});

// ———— schema 追溯:七种形态的语法走查 ————

describe("findSchemaTypeQuery", () => {
  const rootScope = (options: ScopeOptions = {}) => scopeOf(options);

  test("finds a direct typeof argument (z.infer<typeof s>)", () => {
    const hit = findSchemaTypeQuery(
      ref(qualified("z", "infer"), [typeQueryNode("userSchema")]),
      rootScope(),
    );

    expect(hit?.entity).toMatchObject({ kind: "identifier", name: "userSchema" });
  });

  test("finds typeof behind a wrapper type (Omit<z.infer<typeof s>, 'x'>)", () => {
    const hit = findSchemaTypeQuery(
      ref("Omit", [ref(qualified("z", "infer"), [typeQueryNode("s")]), strLit("x")]),
      rootScope(),
    );

    expect(hit?.entity).toMatchObject({ name: "s" });
  });

  test("finds typeof inside union and array forms", () => {
    const viaUnion = findSchemaTypeQuery(
      unionNode([ref("A"), ref(qualified("z", "infer"), [typeQueryNode("s")])]),
      rootScope(),
    );
    const viaArray = findSchemaTypeQuery(
      arrayNode(ref(qualified("z", "infer"), [typeQueryNode("s")])),
      rootScope(),
    );

    expect(viaUnion?.entity).toMatchObject({ name: "s" });
    expect(viaArray?.entity).toMatchObject({ name: "s" });
  });

  test("follows a non-generic alias to its right-hand side in the alias scope", () => {
    const aliasScope: ScopeOptions = { schemaValues: { s: standardSchemaValue() } };
    const hit = findSchemaTypeQuery(
      ref("CreateUser"),
      rootScope({
        aliases: {
          CreateUser: {
            rhs: ref(qualified("z", "infer"), [typeQueryNode("s")]),
            scope: aliasScope,
          },
        },
      }),
    );

    expect(hit?.entity).toMatchObject({ name: "s" });
    // typeof 的值要在别名声明模块解析:命中的 scope 能解析别名模块里的 s。
    expect(hit?.scope.schemaTargetOf(ident("s"))).toBeDefined();
  });

  test("keeps a qualified typeof (typeof shapes.user) with its leftmost identifier reachable", () => {
    const hit = findSchemaTypeQuery(
      ref(qualified("z", "infer"), [typeQueryNode(qualified("shapes", "user"))]),
      rootScope(),
    );

    expect(hit?.entity.kind).toBe("qualified");
  });

  test("does not follow a generic alias (no rhs registered) and stops on cycles", () => {
    const noAlias = findSchemaTypeQuery(ref("Wrapped", [ref("T")]), rootScope());
    const cyclic = findSchemaTypeQuery(
      ref("A"),
      rootScope({
        aliases: {
          A: { rhs: ref("B") },
          B: { rhs: ref("A") },
        },
      }),
    );

    expect(noAlias).toBeUndefined();
    expect(cyclic).toBeUndefined();
  });
});

// ———— schema 追溯:整链(契约来源与 ~standard 判定) ————

describe("resolveRouteSlots schema tracing", () => {
  test("marks a traced Body contract as schema-sourced with its vendor", () => {
    const { contract, diagnostics } = resolveWith(
      [
        parameter(
          0,
          "body",
          ref("Body", [ref(qualified("z", "infer"), [typeQueryNode("userSchema")])]),
        ),
      ],
      {
        parameterTypes: { body: createUserContract },
        schemaValues: { userSchema: standardSchemaValue("zod") },
      },
    );

    expect(diagnostics).toEqual([]);
    expect(contract?.slots[0]).toMatchObject({
      kind: "body",
      contractSource: {
        source: "schema",
        ref: { exportName: "userSchema" },
        vendor: "zod",
      },
    });
  });

  test("falls back to type source when no typeof appears", () => {
    const { contract } = resolveWith([parameter(0, "body", ref("Body", [ref("CreateUser")]))], {
      parameterTypes: { body: createUserContract },
    });

    expect(contract?.slots[0]).toMatchObject({ contractSource: { source: "type" } });
  });

  test("hard-errors when the traced value cannot be resolved", () => {
    const { contract, diagnostics } = resolveWith(
      [parameter(0, "body", ref("Body", [typeQueryNode("missing")]))],
      { parameterTypes: { body: createUserContract } },
    );

    expect(contract).toBeUndefined();
    expect(codesOf(diagnostics)).toEqual(["INVALID_SLOT_SCHEMA"]);
  });

  test("hard-errors when the traced value does not implement Standard Schema", () => {
    const { diagnostics } = resolveWith(
      [parameter(0, "body", ref("Body", [typeQueryNode("plainValue")]))],
      {
        parameterTypes: { body: createUserContract },
        schemaValues: { plainValue: anonymousObject([property("parse", { kind: "function" })]) },
      },
    );

    expect(codesOf(diagnostics)).toEqual(["INVALID_SLOT_SCHEMA"]);
  });
});

// ———— 响应侧 ————

describe("resolveRouteSlots response side", () => {
  test("treats no annotation, Response, void and Promise<void|Response> as passthrough", () => {
    const annotations: readonly (TypeNode | undefined)[] = [
      undefined,
      ref("Response"),
      prim("void"),
      ref("Promise", [prim("void")]),
      ref("Promise", [ref("Response")]),
    ];
    for (const annotation of annotations) {
      const { contract, diagnostics } = resolveWith([], { withQuery: false }, annotation);
      expect(diagnostics).toEqual([]);
      expect(contract?.response).toEqual({ kind: "passthrough" });
    }
  });

  test("expands an annotated Promise<T> response by unwrapping the promise", () => {
    const userView = namedObject("UserView", [
      property("id", intrinsic("bigint")),
      property("name", intrinsic("string")),
    ]);
    const { contract, diagnostics } = resolveWith(
      [],
      { methodType: { kind: "function", returnType: { kind: "promise", argument: userView } } },
      ref("Promise", [ref("UserView")]),
    );

    expect(diagnostics).toEqual([]);
    expect(contract?.response).toMatchObject({
      kind: "table",
      table: { root: { kind: "reference", target: "src/contracts.ts#UserView" } },
    });
  });

  test("expands a plain annotated response without a promise wrapper", () => {
    const userView = namedObject("UserView", [property("id", intrinsic("bigint"))]);
    const { contract } = resolveWith(
      [],
      { methodType: { kind: "function", returnType: userView } },
      ref("UserView"),
    );

    expect(contract?.response.kind).toBe("table");
  });

  test("hard-errors when the annotated response type is outside the contract closed set", () => {
    const { contract, diagnostics } = resolveWith(
      [],
      { methodType: { kind: "function", returnType: { kind: "tuple" } } },
      ref("Pair"),
    );

    expect(contract).toBeUndefined();
    expect(codesOf(diagnostics)).toEqual(["INVALID_CONTRACT_TYPE"]);
  });

  test("hard-errors when the method type is not computable", () => {
    const { diagnostics } = resolveWith([], {}, ref("UserView"));

    expect(codesOf(diagnostics)).toEqual(["INVALID_SLOT_CONTRACT"]);
  });
});

// ———— 无 checker 口径(防御) ————

describe("resolveRouteSlots without a checker", () => {
  test("reports TYPE_CHECKER_UNAVAILABLE only when a query is actually needed", () => {
    const needsQuery = resolveWith([parameter(0, "id", ref("Param", [strLit("id")]))], {
      withQuery: false,
    });
    const bareOnly = resolveWith([parameter(0, "context", ref("RequestContext"))], {
      withQuery: false,
    });

    expect(codesOf(needsQuery.diagnostics)).toEqual(["TYPE_CHECKER_UNAVAILABLE"]);
    expect(bareOnly.diagnostics).toEqual([]);
    expect(bareOnly.contract).toBeDefined();
  });
});
