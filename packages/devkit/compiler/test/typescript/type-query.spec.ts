import { describe, expect, test } from "vitest";
import { StaleCheckerHandleError } from "@/typescript/checker-errors";
import { createTypeQuery, type TypeQuery } from "@/typescript/type-query";
import { SymbolFlags, TypeFlags } from "@/typescript/unstable-api";
import { fakeChecker, fakeProgram, fakeSymbol, fakeType } from "./support/fake-handles";

// TypeQuery 门面(RFC 0012 S1,#273):句柄验籍、error 哨兵翻译、本地 flags 分类。
// 跨 snapshot 句柄在 tsgo 里会静默串味(spike 实测),验籍是这里唯一的正确性护栏。

const file = "/app/src/main.ts";

interface QueryOverrides {
  readonly checker?: Parameters<typeof fakeChecker>[0];
  readonly program?: Parameters<typeof fakeProgram>[0];
  readonly generation?: number;
  readonly isRetired?: () => boolean;
  readonly onTransportFailure?: (error: unknown) => never;
}

function queryOf(overrides: QueryOverrides = {}): TypeQuery {
  return createTypeQuery({
    generation: overrides.generation ?? 1,
    checker: fakeChecker(overrides.checker),
    program: fakeProgram({ getSourceFileNames: () => [file], ...overrides.program }),
    isRetired: overrides.isRetired ?? (() => false),
    onTransportFailure:
      overrides.onTransportFailure ??
      ((error) => {
        throw error;
      }),
  });
}

describe("handle registration", () => {
  test("a handle from another query generation is refused", () => {
    const type = fakeType();
    const first = queryOf({ checker: { getTypeAtPosition: () => [type] } });
    const second = queryOf({ generation: 2 });
    const owned = first.getTypesAtPositions(file, [0])[0];
    if (owned === undefined) {
      throw new Error("expected a type");
    }

    expect(() => second.intrinsicOf(owned)).toThrow(StaleCheckerHandleError);
  });

  test("a retired query refuses every operation", () => {
    const type = fakeType();
    let retired = false;
    const query = queryOf({
      checker: { getTypeAtPosition: () => [type] },
      isRetired: () => retired,
    });
    const owned = query.getTypesAtPositions(file, [0])[0];
    if (owned === undefined) {
      throw new Error("expected a type");
    }
    retired = true;

    expect(() => query.intrinsicOf(owned)).toThrow(StaleCheckerHandleError);
  });

  test("symbols from properties are accepted back for batch type lookup", () => {
    const symbol = fakeSymbol({ name: "a" });
    const object = fakeType({ properties: [symbol] });
    const propertyType = fakeType({ flags: TypeFlags.String });
    const query = queryOf({
      checker: {
        getTypeAtPosition: () => [object],
        getTypeOfSymbol: () => [propertyType],
      },
    });
    const owned = query.getTypesAtPositions(file, [0])[0];
    if (owned === undefined) {
      throw new Error("expected a type");
    }

    const symbols = query.getPropertiesOfType(owned);
    const types = query.getTypesOfSymbols(symbols);

    expect(types).toHaveLength(1);
    expect(types[0] === undefined ? undefined : query.intrinsicOf(types[0])).toBe("string");
  });

  test("a foreign symbol is refused by batch type lookup", () => {
    const query = queryOf({});

    expect(() => query.getTypesOfSymbols([fakeSymbol({ name: "alien" })])).toThrow(
      StaleCheckerHandleError,
    );
  });
});

describe("position queries", () => {
  test("a file outside the checker program answers undefined for every offset", () => {
    let called = false;
    const query = queryOf({
      checker: {
        getTypeAtPosition: () => {
          called = true;
          return [];
        },
      },
    });

    expect(query.getTypesAtPositions("/elsewhere/other.ts", [0, 5])).toEqual([
      undefined,
      undefined,
    ]);
    expect(called).toBe(false);
  });

  test("Windows-style separators still match the program and the canonical name reaches tsgo", () => {
    // Windows CI 实测回归:path.join 的反斜杠拼写对不上 tsgo 的正斜杠规范名,整批查询
    // 被误判"不在 program"。
    const type = fakeType({ flags: TypeFlags.String });
    let queriedFile: string | undefined;
    const query = queryOf({
      checker: {
        getTypeAtPosition: (requestedFile) => {
          queriedFile = requestedFile;
          return [type];
        },
      },
      program: { getSourceFileNames: () => ["C:/app/src/main.ts"] },
    });

    const answers = query.getTypesAtPositions("C:\\app\\src\\main.ts", [0]);

    expect(answers).toHaveLength(1);
    expect(answers[0]).toBeDefined();
    expect(queriedFile).toBe("C:/app/src/main.ts");
  });

  test("the error type sentinel maps to undefined", () => {
    const query = queryOf({
      checker: { getTypeAtPosition: () => [fakeType({ errorType: true })] },
    });

    expect(query.getTypesAtPositions(file, [0])).toEqual([undefined]);
  });

  test("a transport failure is routed to the session hook", () => {
    const failure = new Error("channel closed");
    let seen: unknown;
    const query = queryOf({
      checker: {
        getTypeAtPosition: () => {
          throw failure;
        },
      },
      onTransportFailure: (error) => {
        seen = error;
        throw new Error("translated");
      },
    });

    expect(() => query.getTypesAtPositions(file, [0])).toThrow("translated");
    expect(seen).toBe(failure);
  });
});

describe("local classification", () => {
  function ownedOf(type: ReturnType<typeof fakeType>): {
    query: TypeQuery;
    owned: NonNullable<ReturnType<TypeQuery["getTypesAtPositions"]>[number]>;
  } {
    const query = queryOf({ checker: { getTypeAtPosition: () => [type] } });
    const owned = query.getTypesAtPositions(file, [0])[0];
    if (owned === undefined) {
      throw new Error("expected a type");
    }
    return { query, owned };
  }

  test("the boolean union classifies as the boolean intrinsic", () => {
    const { query, owned } = ownedOf(
      fakeType({ flags: TypeFlags.Boolean | TypeFlags.Union, unionMembers: [] }),
    );

    expect(query.intrinsicOf(owned)).toBe("boolean");
  });

  test("a bigint literal folds its value to a decimal string", () => {
    const { query, owned } = ownedOf(
      fakeType({ flags: TypeFlags.BigIntLiteral, bigintLiteral: true, value: 42n }),
    );

    expect(query.literalOf(owned)).toEqual({ kind: "bigint", value: "42" });
  });

  test("an alias instantiation with type arguments is not a named declaration", () => {
    const alias = fakeSymbol({ name: "Partial", declarationPaths: ["/lib/lib.es5.d.ts"] });
    const { query, owned } = ownedOf(
      fakeType({ aliasSymbol: alias, aliasTypeArguments: [fakeType()] }),
    );

    expect(query.namedDeclarationOf(owned)).toBeUndefined();
  });

  test("a generic interface is not a named declaration", () => {
    const symbol = fakeSymbol({ name: "Box", declarationPaths: ["/app/src/box.ts"] });
    const { query, owned } = ownedOf(
      fakeType({ symbol, classOrInterface: true, typeParameterCount: 1 }),
    );

    expect(query.namedDeclarationOf(owned)).toBeUndefined();
  });

  test("a plain interface names itself with its declaration path", () => {
    const symbol = fakeSymbol({ name: "User", declarationPaths: ["/app/src/user.ts"] });
    const { query, owned } = ownedOf(fakeType({ symbol, classOrInterface: true }));

    expect(query.namedDeclarationOf(owned)).toEqual({
      name: "User",
      declarationPath: "/app/src/user.ts",
    });
  });

  test("an anonymous type literal is not a named declaration", () => {
    const symbol = fakeSymbol({ name: "__type", declarationPaths: ["/app/src/user.ts"] });
    const { query, owned } = ownedOf(fakeType({ symbol, classOrInterface: true }));

    expect(query.namedDeclarationOf(owned)).toBeUndefined();
  });

  test("default-lib declaration checks require every declaration in the default library", () => {
    const metadata = new Map([
      ["/lib/lib.es5.d.ts", true],
      ["/app/src/clash.ts", false],
    ]);
    const program = {
      getSourceFileNames: () => [file],
      getSourceFileMetadata: (path: string) => {
        const isDefaultLibrary = metadata.get(path);
        return isDefaultLibrary === undefined ? undefined : { isDefaultLibrary };
      },
    };
    const pureLib = fakeType({
      symbol: fakeSymbol({ name: "Date", declarationPaths: ["/lib/lib.es5.d.ts"] }),
    });
    const mixed = fakeType({
      symbol: fakeSymbol({
        name: "Clash",
        declarationPaths: ["/lib/lib.es5.d.ts", "/app/src/clash.ts"],
      }),
    });
    const query = queryOf({
      checker: { getTypeAtPosition: () => [pureLib, mixed] },
      program,
    });
    const [ownedLib, ownedMixed] = query.getTypesAtPositions(file, [0, 1]);
    if (ownedLib === undefined || ownedMixed === undefined) {
      throw new Error("expected types");
    }

    expect(query.isDeclaredInDefaultLib(ownedLib)).toBe(true);
    expect(query.isDeclaredInDefaultLib(ownedMixed)).toBe(false);
  });

  test("class symbols classify as class types", () => {
    const { query, owned } = ownedOf(
      fakeType({ symbol: fakeSymbol({ name: "Entity", flags: SymbolFlags.Class }) }),
    );

    expect(query.isClassType(owned)).toBe(true);
  });

  test("the optional symbol flag is read locally", () => {
    const optional = fakeSymbol({ name: "a", flags: SymbolFlags.Optional });
    const object = fakeType({ properties: [optional] });
    const query = queryOf({ checker: { getTypeAtPosition: () => [object] } });
    const owned = query.getTypesAtPositions(file, [0])[0];
    if (owned === undefined) {
      throw new Error("expected a type");
    }

    const [symbol] = query.getPropertiesOfType(owned);
    expect(symbol === undefined ? undefined : query.isOptionalProperty(symbol)).toBe(true);
  });
});
