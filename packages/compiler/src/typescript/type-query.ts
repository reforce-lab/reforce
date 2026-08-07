import { StaleCheckerHandleError } from "@/typescript/checker-errors";
import {
  SymbolFlags,
  type TsSymbol,
  type TsType,
  type TsTypeReference,
  TypeFlags,
} from "@/typescript/unstable-api";

// TypeQuery 门面(RFC 0012 S1,#273):字段表算法与 tsgo checker 之间的唯一通道。
// - 返回值就是 tsgo 的裸 Type/Symbol 句柄,不做二次包装:flags/谓词/字面量 value 全部本地零 IPC,
//   包装一层会丢掉 dev 版按句柄 memoize 的查询缓存。
// - 泛型参数 TType/TSymbol 让 type-contract 及其单测替身完全不依赖 unstable 类型面:算法只认
//   这里声明的语义操作,句柄对它是不透明的。
// - 安全网:tsgo 的句柄 id 是 snapshot 内标识,跨 snapshot 撞车会静默返回错误答案(spike 实测),
//   所以门面把发出的每个句柄登记进本代 WeakSet,收到句柄先验籍,旧代句柄立刻硬错。

export type QueryIntrinsicKind =
  | "string"
  | "number"
  | "bigint"
  | "boolean"
  | "null"
  | "undefined"
  | "void"
  | "any"
  | "unknown"
  | "never"
  | "symbol"
  | "nonPrimitive";

export type QueryLiteralValue =
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  // bigint 存十进制字符串:字段表要求 plain-JSON 可序列化,门面在源头统一。
  | { readonly kind: "bigint"; readonly value: string };

export interface QueryNamedDeclaration {
  readonly name: string;
  // 声明文件的绝对路径。项目归属判定(能否映射到 ParsedSource.fileId)留给调用方。
  readonly declarationPath: string;
}

export interface TypeQueryOf<TType, TSymbol> {
  readonly generation: number;
  // 位置查询:offset 是 UTF-16 code unit(SourceSpan.start.offset 同口径,spike ① 实测)。
  // 文件不属于 checker program 时整批返回 undefined——tsgo 对未知文件是抛错而不是空答案,
  // 门面用文件名集合先挡一层,保持"类型不可用"语义(spike ③)。
  getTypesAtPositions(
    absolutePath: string,
    offsets: readonly number[],
  ): readonly (TType | undefined)[];
  // 联合/交叉展开,本地零 IPC;非对应形态返回 undefined。
  // 注意 `boolean` 也带 Union flag(true|false),调用方必须先问 intrinsicOf。
  unionMembers(type: TType): readonly TType[] | undefined;
  intersectionMembers(type: TType): readonly TType[] | undefined;
  // 标量分类,本地 flags;字面量类型不在此列(走 literalOf)。
  intrinsicOf(type: TType): QueryIntrinsicKind | undefined;
  // 字面量分类,本地 flags + value;enum 成员携带字面量 flags,自然命中(spike ⑤)。
  literalOf(type: TType): QueryLiteralValue | undefined;
  isTemplateLiteralType(type: TType): boolean;
  isArrayType(type: TType): boolean;
  isTupleType(type: TType): boolean;
  arrayElementType(type: TType): TType | undefined;
  getPropertiesOfType(type: TType): readonly TSymbol[];
  // 一趟批量 IPC(IPC 摊薄主手段);checker 对取不出类型的 symbol 返回 error type 哨兵,
  // 门面统一翻译成 undefined = "类型不可用"。
  getTypesOfSymbols(symbols: readonly TSymbol[]): readonly (TType | undefined)[];
  hasIndexSignature(type: TType): boolean;
  hasCallSignatures(type: TType): boolean;
  symbolNameOf(symbol: TSymbol): string;
  isOptionalProperty(symbol: TSymbol): boolean;
  // 命名类型判定,取 aliasSymbol ?? symbol:
  // - 匿名类型字面量(checker 内部名 __type/__object)返回 undefined;
  // - 泛型实例化(alias 带实参、interface 引用带类型实参)返回 undefined——同名不同实参会在
  //   definitions 表里撞 key,S1 一律按匿名内联处理。
  namedDeclarationOf(type: TType): QueryNamedDeclaration | undefined;
  // 内置类型判定的唯一判据:symbol 的全部声明都落在默认库文件(spike ⑨)。
  isDeclaredInDefaultLib(type: TType): boolean;
  isClassType(type: TType): boolean;
  // 同 snapshot 内稳定(spike ⑩),内联展开的终止判据。
  typeId(type: TType): number;
  typeToString(type: TType): string;
}

export type TypeQuery = TypeQueryOf<TsType, TsSymbol>;

// 会话层依赖面收窄成结构接口:真实 Checker/Program 类实例直接结构赋值,单测替身只需实现这几个
// 成员。替身理由:边界是 tsgo 子进程 IPC。
export interface CheckerPort {
  getTypeAtPosition(file: string, positions: readonly number[]): readonly (TsType | undefined)[];
  getTypeOfSymbol(symbols: readonly TsSymbol[]): readonly TsType[];
  getTypeArguments(type: TsTypeReference): readonly TsType[];
  isArrayType(type: TsType): boolean;
  isTupleType(type: TsType): boolean;
  typeToString(type: TsType): string;
}

export interface ProgramPort {
  getSourceFileNames(): readonly string[];
  getSourceFileMetadata(fileName: string): { readonly isDefaultLibrary: boolean } | undefined;
}

export interface CreateTypeQueryInput {
  readonly generation: number;
  // checker/program 是访问器:会话层用它们实现懒 spawn(首次真正查询才建进程与 snapshot),
  // 门面在每次操作时取值,创建门面本身零成本。
  readonly checker: CheckerPort;
  readonly program: ProgramPort;
  // IPC 失败的统一出口:由会话层标记崩溃并抛 CheckerUnavailableError,门面自己不吞不译。
  readonly onTransportFailure: (error: unknown) => never;
  readonly isRetired: () => boolean;
}

const anonymousSymbolNames = new Set(["__type", "__object"]);

// program 成员比对的路径折叠:tsgo 返回正斜杠规范名,Node path.join 在 Windows 上给反斜杠,
// 精确比对会把项目文件整批误判成"不在 program"(CI 实测);Windows 文件系统大小写不敏感,
// 盘符大小写也一并折叠。查询发往 server 时用 tsgo 侧的规范名,不用调用方原始拼写。
function canonicalPathKey(filePath: string): string {
  const portable = filePath.replaceAll("\\", "/");
  return process.platform === "win32" ? portable.toLowerCase() : portable;
}

function intrinsicKindOfFlags(flags: number): QueryIntrinsicKind | undefined {
  if (flags & TypeFlags.String) {
    return "string";
  }
  if (flags & TypeFlags.Number) {
    return "number";
  }
  if (flags & TypeFlags.BigInt) {
    return "bigint";
  }
  if (flags & TypeFlags.Boolean) {
    return "boolean";
  }
  if (flags & TypeFlags.Null) {
    return "null";
  }
  if (flags & TypeFlags.Undefined) {
    return "undefined";
  }
  if (flags & TypeFlags.Void) {
    return "void";
  }
  if (flags & TypeFlags.Any) {
    return "any";
  }
  if (flags & TypeFlags.Unknown) {
    return "unknown";
  }
  if (flags & TypeFlags.Never) {
    return "never";
  }
  if (flags & (TypeFlags.ESSymbol | TypeFlags.UniqueESSymbol)) {
    return "symbol";
  }
  if (flags & TypeFlags.NonPrimitive) {
    return "nonPrimitive";
  }
  return undefined;
}

export function createTypeQuery(input: CreateTypeQueryInput): TypeQuery {
  const generation = input.generation;
  // 本代句柄登记表:门面发出的每个 Type/Symbol 都在这里挂籍,收到时验籍。
  const ownedTypes = new WeakSet<TsType>();
  const ownedSymbols = new WeakSet<TsSymbol>();
  // program 文件名集合与 default-lib 判定都是 snapshot 级事实,首次查询后本地缓存。
  // key 是折叠后的路径,value 是 tsgo 侧的规范文件名。
  let programFilesByKey: ReadonlyMap<string, string> | undefined;
  const defaultLibraryByPath = new Map<string, boolean>();
  const namedDeclarationByTypeId = new Map<number, QueryNamedDeclaration | undefined>();

  function guard<T>(operation: () => T): T {
    if (input.isRetired()) {
      throw new StaleCheckerHandleError(
        `Type query of generation ${generation} was used after its compile pass retired it.`,
      );
    }
    try {
      return operation();
    } catch (error) {
      if (error instanceof StaleCheckerHandleError) {
        throw error;
      }
      return input.onTransportFailure(error);
    }
  }

  function adoptType(type: TsType): TsType {
    ownedTypes.add(type);
    return type;
  }

  function adoptSymbol(symbol: TsSymbol): TsSymbol {
    ownedSymbols.add(symbol);
    return symbol;
  }

  function expectOwnedType(type: TsType): TsType {
    if (!ownedTypes.has(type)) {
      throw new StaleCheckerHandleError(
        `A type handle from another snapshot generation reached generation ${generation}.`,
      );
    }
    return type;
  }

  function expectOwnedSymbol(symbol: TsSymbol): TsSymbol {
    if (!ownedSymbols.has(symbol)) {
      throw new StaleCheckerHandleError(
        `A symbol handle from another snapshot generation reached generation ${generation}.`,
      );
    }
    return symbol;
  }

  function isDefaultLibraryPath(path: string): boolean {
    let known = defaultLibraryByPath.get(path);
    if (known === undefined) {
      known = input.program.getSourceFileMetadata(path)?.isDefaultLibrary === true;
      defaultLibraryByPath.set(path, known);
    }
    return known;
  }

  function declarationOf(symbol: TsSymbol): QueryNamedDeclaration | undefined {
    const declarationPath = symbol.declarations[0]?.path;
    return declarationPath === undefined ? undefined : { name: symbol.name, declarationPath };
  }

  function namedDeclarationOfType(type: TsType): QueryNamedDeclaration | undefined {
    const alias = type.getAliasSymbol();
    if (alias !== undefined) {
      return type.getAliasTypeArguments().length > 0 ? undefined : declarationOf(alias);
    }
    // alias 之外只认 class/interface 声明为命名类型:类型字面量的 symbol 是内部名 __type,
    // 泛型实例化是 Reference 而非 ClassOrInterface,两者都按匿名内联处理。
    if (!type.isClassOrInterface() || type.getTypeParameters().length > 0) {
      return undefined;
    }
    const symbol = type.getSymbol();
    if (symbol === undefined || anonymousSymbolNames.has(symbol.name)) {
      return undefined;
    }
    return declarationOf(symbol);
  }

  return {
    generation,
    getTypesAtPositions(absolutePath, offsets) {
      return guard(() => {
        programFilesByKey ??= new Map(
          input.program.getSourceFileNames().map((name) => [canonicalPathKey(name), name]),
        );
        const canonicalName = programFilesByKey.get(canonicalPathKey(absolutePath));
        if (canonicalName === undefined) {
          return offsets.map(() => undefined);
        }
        return input.checker
          .getTypeAtPosition(canonicalName, offsets)
          .map((type) => (type === undefined || type.isErrorType() ? undefined : adoptType(type)));
      });
    },
    unionMembers(type) {
      return guard(() => {
        const owned = expectOwnedType(type);
        return owned.isUnionType() ? owned.getTypes().map(adoptType) : undefined;
      });
    },
    intersectionMembers(type) {
      return guard(() => {
        const owned = expectOwnedType(type);
        return owned.isIntersectionType() ? owned.getTypes().map(adoptType) : undefined;
      });
    },
    intrinsicOf(type) {
      return guard(() => intrinsicKindOfFlags(expectOwnedType(type).flags));
    },
    literalOf(type) {
      return guard(() => {
        const owned = expectOwnedType(type);
        if (owned.isStringLiteralType()) {
          return { kind: "string", value: owned.value } as const;
        }
        if (owned.isNumberLiteralType()) {
          return { kind: "number", value: owned.value } as const;
        }
        if (owned.isBooleanLiteralType()) {
          return { kind: "boolean", value: owned.value } as const;
        }
        if (owned.isBigIntLiteralType()) {
          return { kind: "bigint", value: owned.value.toString() } as const;
        }
        return undefined;
      });
    },
    isTemplateLiteralType(type) {
      return guard(() => expectOwnedType(type).isTemplateLiteralType());
    },
    isArrayType(type) {
      return guard(() => input.checker.isArrayType(expectOwnedType(type)));
    },
    isTupleType(type) {
      return guard(() => input.checker.isTupleType(expectOwnedType(type)));
    },
    arrayElementType(type) {
      return guard(() => {
        const owned = expectOwnedType(type);
        if (!input.checker.isArrayType(owned) || !owned.isTypeReference()) {
          return undefined;
        }
        const element = input.checker.getTypeArguments(owned)[0];
        return element === undefined ? undefined : adoptType(element);
      });
    },
    getPropertiesOfType(type) {
      return guard(() => expectOwnedType(type).getProperties().map(adoptSymbol));
    },
    getTypesOfSymbols(symbols) {
      return guard(() => {
        if (symbols.length === 0) {
          return [];
        }
        return input.checker
          .getTypeOfSymbol(symbols.map(expectOwnedSymbol))
          .map((type) => (type.isErrorType() ? undefined : adoptType(type)));
      });
    },
    hasIndexSignature(type) {
      return guard(() => expectOwnedType(type).getIndexInfos().length > 0);
    },
    hasCallSignatures(type) {
      return guard(() => expectOwnedType(type).getCallSignatures().length > 0);
    },
    symbolNameOf(symbol) {
      return guard(() => expectOwnedSymbol(symbol).name);
    },
    isOptionalProperty(symbol) {
      return guard(() => (expectOwnedSymbol(symbol).flags & SymbolFlags.Optional) !== 0);
    },
    namedDeclarationOf(type) {
      return guard(() => {
        const owned = expectOwnedType(type);
        if (namedDeclarationByTypeId.has(owned.id)) {
          return namedDeclarationByTypeId.get(owned.id);
        }
        const named = namedDeclarationOfType(owned);
        namedDeclarationByTypeId.set(owned.id, named);
        return named;
      });
    },
    isDeclaredInDefaultLib(type) {
      return guard(() => {
        const symbol = expectOwnedType(type).getSymbol();
        // 匿名 symbol(__type/__object)不算内置:lib 里 Partial/Omit 的映射类型字面量声明在
        // lib.es5.d.ts,但它们的实例化是用户数据形状,只有 Date/Set 这类命名声明才是内置对象。
        if (symbol === undefined || anonymousSymbolNames.has(symbol.name)) {
          return false;
        }
        return (
          symbol.declarations.length > 0 &&
          symbol.declarations.every((declaration) => isDefaultLibraryPath(declaration.path))
        );
      });
    },
    isClassType(type) {
      return guard(() => {
        const symbol = expectOwnedType(type).getSymbol();
        return symbol !== undefined && (symbol.flags & SymbolFlags.Class) !== 0;
      });
    },
    typeId(type) {
      return guard(() => expectOwnedType(type).id);
    },
    typeToString(type) {
      return guard(() => input.checker.typeToString(expectOwnedType(type)));
    },
  };
}
