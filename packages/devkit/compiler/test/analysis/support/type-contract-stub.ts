import type {
  QueryIntrinsicKind,
  QueryLiteralValue,
  QueryNamedDeclaration,
  TypeQueryOf,
} from "@/typescript/type-query";

// 字段表算法的内存类型图替身(RFC 0012 S1,#273)。TypeQuery 是我们自己的门面接口,泛型句柄
// 让替身完全不依赖 unstable 类型面——算法的全部分支在毫秒级单测里钉住,真 checker 语义漂移
// 由 it/type-contract.spec.ts 兜底。替身理由:真实句柄只能从 tsgo 子进程获得。

export interface StubProperty {
  readonly name: string;
  readonly optional?: boolean;
  // undefined = 类型不可用(对应真 checker 的 error type 哨兵)。
  readonly type?: StubType | undefined;
}

export type StubType =
  | { readonly kind: "intrinsic"; readonly intrinsic: QueryIntrinsicKind }
  | { readonly kind: "literal"; readonly literal: QueryLiteralValue }
  | { readonly kind: "template" }
  | { readonly kind: "tuple" }
  | { kind: "array"; element: StubType }
  | { kind: "union"; members: StubType[]; named?: QueryNamedDeclaration | undefined }
  | {
      kind: "object";
      properties: StubProperty[];
      named?: QueryNamedDeclaration | undefined;
      defaultLib?: boolean;
      isClass?: boolean;
      indexSignature?: boolean;
      callable?: boolean;
    }
  | {
      kind: "intersection";
      members: StubType[];
      properties: StubProperty[];
      indexSignature?: boolean;
    }
  // 槽位解析(RFC 0012 S2,#274)的响应侧:方法名位查到的函数类型与 Promise 包装。
  | { kind: "function"; returnType?: StubType }
  | { kind: "promise"; argument: StubType };

export type StubQuery = TypeQueryOf<StubType, StubProperty>;

export function createStubQuery(): StubQuery {
  const identifiers = new WeakMap<StubType, number>();
  let nextIdentifier = 1;
  return {
    generation: 1,
    getTypesAtPositions() {
      throw new Error("Unit tests hand the entry type to expandTypeContract directly.");
    },
    unionMembers(type) {
      return type.kind === "union" ? type.members : undefined;
    },
    intersectionMembers(type) {
      return type.kind === "intersection" ? type.members : undefined;
    },
    intrinsicOf(type) {
      return type.kind === "intrinsic" ? type.intrinsic : undefined;
    },
    literalOf(type) {
      return type.kind === "literal" ? type.literal : undefined;
    },
    isTemplateLiteralType(type) {
      return type.kind === "template";
    },
    isArrayType(type) {
      return type.kind === "array";
    },
    isTupleType(type) {
      return type.kind === "tuple";
    },
    arrayElementType(type) {
      return type.kind === "array" ? type.element : undefined;
    },
    getPropertiesOfType(type) {
      return type.kind === "object" || type.kind === "intersection" ? type.properties : [];
    },
    getTypesOfSymbols(symbols) {
      return symbols.map((symbol) => symbol.type);
    },
    hasIndexSignature(type) {
      return (
        (type.kind === "object" || type.kind === "intersection") && type.indexSignature === true
      );
    },
    hasCallSignatures(type) {
      return (type.kind === "object" && type.callable === true) || type.kind === "function";
    },
    callSignatureReturnTypes(type) {
      return type.kind === "function" ? [type.returnType] : [];
    },
    promiseTypeArgument(type) {
      return type.kind === "promise" ? type.argument : undefined;
    },
    symbolNameOf(symbol) {
      return symbol.name;
    },
    isOptionalProperty(symbol) {
      return symbol.optional === true;
    },
    namedDeclarationOf(type) {
      return type.kind === "object" || type.kind === "union" ? type.named : undefined;
    },
    isDeclaredInDefaultLib(type) {
      return type.kind === "object" && type.defaultLib === true;
    },
    isClassType(type) {
      return type.kind === "object" && type.isClass === true;
    },
    typeId(type) {
      let identifier = identifiers.get(type);
      if (identifier === undefined) {
        identifier = nextIdentifier;
        nextIdentifier += 1;
        identifiers.set(type, identifier);
      }
      return identifier;
    },
    typeToString(type) {
      return type.kind === "object" || type.kind === "union"
        ? (type.named?.name ?? `<${type.kind}>`)
        : `<${type.kind}>`;
    },
  };
}

// 构造便签:让用例读起来接近类型标注本身。
export function intrinsic(kind: QueryIntrinsicKind): StubType {
  return { kind: "intrinsic", intrinsic: kind };
}

export function literal(value: QueryLiteralValue): StubType {
  return { kind: "literal", literal: value };
}

export function stringLiteral(value: string): StubType {
  return literal({ kind: "string", value });
}

export function union(members: StubType[], named?: QueryNamedDeclaration): StubType {
  return { kind: "union", members, named };
}

export function array(element: StubType): StubType {
  return { kind: "array", element };
}

export function property(name: string, type: StubType | undefined, optional = false): StubProperty {
  return { name, optional, type };
}

export function anonymousObject(properties: StubProperty[]): StubType {
  return { kind: "object", properties };
}

// declarationPath 以 /app/ 开头即视为项目内(见 spec 的 fileIdOf)。
export function projectNamed(name: string, file = "src/contracts.ts"): QueryNamedDeclaration {
  return { name, declarationPath: `/app/${file}` };
}

export function namedObject(
  name: string,
  properties: StubProperty[],
  file?: string,
): StubType & { kind: "object" } {
  return { kind: "object", properties, named: projectNamed(name, file) };
}

export function dateType(): StubType {
  return {
    kind: "object",
    properties: [],
    named: { name: "Date", declarationPath: "/lib/lib.es5.d.ts" },
    defaultLib: true,
  };
}
