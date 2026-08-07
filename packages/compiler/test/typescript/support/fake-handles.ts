import type { CheckerPort, ProgramPort } from "@/typescript/type-query";
import type { TsSymbol, TsType } from "@/typescript/unstable-api";

// 门面单测的句柄替身(RFC 0012 S1,#273)。真实 Type/Symbol 只能从 tsgo 子进程获得,单测只
// 构造门面实际触达的成员面。替身理由:边界是 tsgo 子进程 IPC。

let nextTypeId = 1;

export interface FakeTypeInput {
  readonly flags?: number;
  readonly value?: string | number | boolean | bigint;
  readonly symbol?: TsSymbol;
  readonly aliasSymbol?: TsSymbol;
  readonly aliasTypeArguments?: readonly TsType[];
  readonly unionMembers?: readonly TsType[];
  readonly intersectionMembers?: readonly TsType[];
  readonly properties?: readonly TsSymbol[];
  readonly indexInfoCount?: number;
  readonly callSignatureCount?: number;
  readonly classOrInterface?: boolean;
  readonly typeParameterCount?: number;
  readonly errorType?: boolean;
  readonly templateLiteral?: boolean;
  readonly stringLiteral?: boolean;
  readonly numberLiteral?: boolean;
  readonly booleanLiteral?: boolean;
  readonly bigintLiteral?: boolean;
}

export function fakeType(input: FakeTypeInput = {}): TsType {
  const handle = {
    flags: input.flags ?? 0,
    id: nextTypeId++,
    value: input.value,
    getSymbol: () => input.symbol,
    getAliasSymbol: () => input.aliasSymbol,
    getAliasTypeArguments: () => input.aliasTypeArguments ?? [],
    getProperties: () => input.properties ?? [],
    getIndexInfos: () => Array.from({ length: input.indexInfoCount ?? 0 }, () => ({})),
    getCallSignatures: () => Array.from({ length: input.callSignatureCount ?? 0 }, () => ({})),
    getTypes: () => input.unionMembers ?? input.intersectionMembers ?? [],
    getTypeParameters: () => Array.from({ length: input.typeParameterCount ?? 0 }, () => ({})),
    isUnionType: () => input.unionMembers !== undefined,
    isIntersectionType: () => input.intersectionMembers !== undefined,
    isClassOrInterface: () => input.classOrInterface === true,
    isTypeReference: () => false,
    isErrorType: () => input.errorType === true,
    isTemplateLiteralType: () => input.templateLiteral === true,
    isStringLiteralType: () => input.stringLiteral === true,
    isNumberLiteralType: () => input.numberLiteral === true,
    isBooleanLiteralType: () => input.booleanLiteral === true,
    isBigIntLiteralType: () => input.bigintLiteral === true,
  };
  // 门面只触达上面这些成员;完整 Type 接口的其余方法在单测里永不可达。替身边界:tsgo IPC。
  return handle as unknown as TsType;
}

export interface FakeSymbolInput {
  readonly name: string;
  readonly flags?: number;
  readonly declarationPaths?: readonly string[];
}

export function fakeSymbol(input: FakeSymbolInput): TsSymbol {
  const handle = {
    name: input.name,
    flags: input.flags ?? 0,
    declarations: (input.declarationPaths ?? []).map((path) => ({ path })),
  };
  // 同上:只构造门面触达的成员面。替身边界:tsgo IPC。
  return handle as unknown as TsSymbol;
}

export function fakeChecker(overrides: Partial<CheckerPort> = {}): CheckerPort {
  return {
    getTypeAtPosition: () => {
      throw new Error("unexpected getTypeAtPosition");
    },
    getTypeOfSymbol: () => {
      throw new Error("unexpected getTypeOfSymbol");
    },
    getTypeArguments: () => [],
    getReturnTypeOfSignature: () => {
      throw new Error("unexpected getReturnTypeOfSignature");
    },
    isArrayType: () => false,
    isTupleType: () => false,
    typeToString: () => "<fake>",
    ...overrides,
  };
}

export function fakeProgram(overrides: Partial<ProgramPort> = {}): ProgramPort {
  return {
    getSourceFileNames: () => [],
    getSourceFileMetadata: () => undefined,
    ...overrides,
  };
}
