import type { SourceSpan } from "@/parser/source-location";
import type { SuppressionComment } from "@/parser/suppressions";

export type SourceKind = "ts" | "tsx" | "mts" | "cts" | "d.ts" | "d.mts" | "d.cts";

export type EntityName =
  | {
      readonly kind: "identifier";
      readonly name: string;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "qualified";
      readonly left: EntityName;
      readonly right: string;
      readonly span: SourceSpan;
    };

export type TypeNode =
  | {
      readonly kind: "reference";
      readonly name: EntityName;
      readonly typeArguments: readonly TypeNode[];
      readonly span: SourceSpan;
    }
  | {
      // T[] 与 readonly T[]（ADR 0006 W6，#142）：readonly 与否必须保真下传——分析层要用它区分
      // 合法集合边（readonly）与需要指引改写的可变数组。
      readonly kind: "array";
      readonly element: TypeNode;
      readonly readonlyModifier: boolean;
      readonly span: SourceSpan;
    }
  | {
      // 槽位解析（RFC 0012 S2，#274）要在语法层裁决"裸标量当键名"（Param<string> 硬错）与
      // 可选单键（Header<"x" | undefined>），undefined 因此必须是可表达的 primitive。
      readonly kind: "primitive";
      readonly name: "void" | "string" | "number" | "bigint" | "boolean" | "undefined";
      readonly span: SourceSpan;
    }
  | {
      // 单键槽位写法 Param<"id">（RFC 0012 S2，#274）：第一实参是字符串字面量类型。
      readonly kind: "string-literal";
      readonly value: string;
      readonly span: SourceSpan;
    }
  | {
      // 可选单键（"x" | undefined）与字面量联合硬错的形态裁决都在语法层做（#274）。
      readonly kind: "union";
      readonly members: readonly TypeNode[];
      readonly span: SourceSpan;
    }
  | {
      // typeof X（#274 schema 追溯）：槽位契约写 z.infer<typeof schema> 时，语法层要在类型
      // 实参树里找到被 typeof 引用的值标识符，才能把解码器换成用户 schema。
      readonly kind: "type-query";
      readonly name: EntityName;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "unsupported";
      readonly span: SourceSpan;
    };

export type UnsupportedExpressionKind =
  | "identifier"
  | "call"
  | "member"
  | "conditional"
  | "object"
  | "array"
  | "template"
  | "numeric"
  | "bigint"
  | "null"
  | "function"
  | "class"
  | "new"
  | "await"
  | "yield"
  | "assignment"
  | "sequence"
  | "unary"
  | "binary"
  | "logical"
  | "update"
  | "this"
  | "super"
  | "jsx"
  | "other";

export type ExpressionValue =
  | {
      readonly kind: "string-literal";
      readonly value: string;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "boolean-literal";
      readonly value: boolean;
      readonly span: SourceSpan;
    }
  | {
      // 数字字面量含一元负号形态（@Order(-1)）；只认字面量，其余数值表达式照旧 unsupported。
      readonly kind: "number-literal";
      readonly value: number;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "unsupported";
      readonly expressionKind: UnsupportedExpressionKind;
      readonly span: SourceSpan;
    };

export type DecoratorCallee =
  | EntityName
  | {
      readonly kind: "unsupported-expression";
      readonly expressionKind: UnsupportedExpressionKind;
      readonly span: SourceSpan;
    };

// 装饰器参数比其余表达式位多认三类形态（ADR 0006 W3/W5，#142 / #152）：路由 marker 的
// JSON 字面量树（数组/对象/null）与 schema/中间件引用（标识符）。其余表达式位（defineBean
// 选项、heritage 实参）保持窄的 ExpressionValue——放宽哪个位是各自分析层的决定，不在
// parser 一刀切。
export type DecoratorArgumentValue =
  | ExpressionValue
  | {
      readonly kind: "null-literal";
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "array-literal";
      readonly elements: readonly DecoratorArgumentValue[];
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "object-literal";
      readonly properties: readonly ObjectLiteralProperty[];
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "identifier-reference";
      readonly entity: EntityName;
      readonly span: SourceSpan;
    };

export type ObjectLiteralProperty =
  | {
      readonly kind: "property";
      readonly key: string;
      readonly value: DecoratorArgumentValue;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "unsupported-property";
      readonly propertyKind: "computed" | "method" | "spread";
      readonly span: SourceSpan;
    };

export interface DecoratorUse {
  readonly kind: "decorator";
  readonly callee: DecoratorCallee;
  readonly called: boolean;
  readonly arguments: readonly DecoratorArgumentValue[];
  readonly span: SourceSpan;
}

export type DeclarationExport =
  | { readonly kind: "none" }
  | {
      readonly kind: "named";
      readonly exportedName: string;
      readonly span: SourceSpan;
    }
  | { readonly kind: "default-only"; readonly span: SourceSpan };

export type ImportBinding =
  | {
      readonly kind: "default";
      readonly local: string;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "namespace";
      readonly local: string;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "named";
      readonly imported: string;
      readonly local: string;
      readonly span: SourceSpan;
    };

export type ImportDeclaration =
  | {
      readonly kind: "import";
      readonly moduleSpecifier: string;
      readonly bindings: readonly ImportBinding[];
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "unsupported-import";
      readonly syntaxKind: "import-equals" | "attributes" | "other";
      readonly span: SourceSpan;
    };

export interface ExportSpecifier {
  readonly local: string;
  readonly exported: string;
  readonly span: SourceSpan;
}

export type ExportDeclaration =
  | {
      readonly kind: "local-named";
      readonly specifiers: readonly ExportSpecifier[];
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "reexport-named";
      readonly moduleSpecifier: string;
      readonly specifiers: readonly ExportSpecifier[];
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "reexport-all";
      readonly moduleSpecifier: string;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "namespace";
      readonly moduleSpecifier: string;
      readonly exported: string;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "default-local";
      readonly local: string;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "default-expression";
      readonly expressionKind: UnsupportedExpressionKind;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "unsupported-export";
      readonly syntaxKind: "export-assignment" | "attributes" | "other";
      readonly span: SourceSpan;
    };

export interface InterfaceDeclaration {
  readonly kind: "interface";
  readonly topLevel: boolean;
  readonly name?: string;
  readonly export: DeclarationExport;
  readonly generic: boolean;
  readonly extends: readonly TypeNode[];
  readonly span: SourceSpan;
}

export type NamespaceMemberKind = "type" | "value" | "namespace";

export interface NamespaceExportedMember {
  readonly kind: NamespaceMemberKind;
  readonly name: string;
  readonly span: SourceSpan;
}

export interface NamespaceDeclaration {
  readonly kind: "namespace";
  readonly topLevel: boolean;
  readonly name: string;
  readonly export: DeclarationExport;
  readonly exportedMembers: readonly NamespaceExportedMember[];
  readonly span: SourceSpan;
}

export interface ConstructorParameter {
  readonly kind: "constructor-parameter";
  readonly index: number;
  readonly type: TypeNode;
  readonly optional: boolean;
  readonly rest: boolean;
  readonly hasInitializer: boolean;
  readonly decorators: readonly DecoratorUse[];
  readonly span: SourceSpan;
}

export interface ConstructorDeclaration {
  readonly kind: "constructor";
  readonly accessibility: "public" | "protected" | "private";
  readonly implementation: boolean;
  readonly parameters: readonly ConstructorParameter[];
  readonly span: SourceSpan;
}

export type ClassMethodName =
  | { readonly kind: "identifier"; readonly name: string }
  | {
      readonly kind: "string-literal";
      readonly value: string;
      readonly span: SourceSpan;
    }
  | { readonly kind: "computed"; readonly span: SourceSpan };

// 路由 handler 的逐参数槽位解析（RFC 0012 S2，#274）需要每个参数的名字位置与类型标注：
// name/nameSpan 只对标识符模式存在（解构/rest 留给槽位解析层发硬错）；nameSpan 是 checker
// 位置查询的锚点——类型注解位对 error type 查不出东西，必须查参数名位。不复用
// ConstructorParameter：它带 decorators、无 nameSpan，合并会牵动构造器消费面。
export interface MethodParameter {
  readonly kind: "method-parameter";
  readonly index: number;
  readonly name?: string;
  readonly nameSpan?: SourceSpan;
  readonly typeAnnotation?: TypeNode;
  readonly optional: boolean;
  readonly rest: boolean;
  readonly hasInitializer: boolean;
  readonly span: SourceSpan;
}

export interface ClassMethodDeclaration {
  readonly kind: "method";
  readonly name: ClassMethodName;
  readonly static: boolean;
  readonly accessibility: "public" | "protected" | "private";
  readonly async: boolean;
  readonly generator: boolean;
  readonly optional: boolean;
  readonly implementation: boolean;
  readonly parameters: readonly MethodParameter[];
  readonly returnType?: TypeNode;
  // 方法级装饰器服务路由提取（ADR 0006 W3，#152）：@Get/@Post、@Use 与路由 marker 都落在
  // handler 方法上，分析层经链接核实来源后消费。
  readonly decorators: readonly DecoratorUse[];
  readonly span: SourceSpan;
}

// extends 位置只有三种可分析形状：直接调用、实体引用、其余表达式。其余表达式不丢弃而是
// 收集其中出现的标识符名，让链接层能发现"引用了 ConfigProperties 却不是直接调用"的写法并
// 硬错（ADR 0005 决策 5.1，#54 教训：禁止静默跳过）。
export type ClassHeritage =
  | {
      readonly kind: "call";
      readonly callee: EntityName;
      readonly arguments: readonly ExpressionValue[];
      readonly parenthesized: boolean;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "reference";
      readonly entity: EntityName;
      readonly parenthesized: boolean;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "expression";
      readonly referencedNames: readonly string[];
      readonly span: SourceSpan;
    };

export interface ClassFieldDeclaration {
  readonly kind: "class-field";
  readonly name?: string;
  readonly static: boolean;
  readonly span: SourceSpan;
}

export interface ClassDeclaration {
  readonly kind: "class";
  readonly topLevel: boolean;
  readonly abstract: boolean;
  readonly name?: string;
  readonly export: DeclarationExport;
  readonly generic: boolean;
  readonly decorators: readonly DecoratorUse[];
  readonly heritage?: ClassHeritage;
  readonly implements: readonly TypeNode[];
  readonly fields: readonly ClassFieldDeclaration[];
  readonly constructors: readonly ConstructorDeclaration[];
  readonly methods: readonly ClassMethodDeclaration[];
  readonly span: SourceSpan;
}

export type FunctionBodyDescriptor =
  | {
      readonly kind: "direct-new";
      readonly callee: EntityName;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "unsupported";
      readonly expressionKind: UnsupportedExpressionKind;
      readonly span: SourceSpan;
    };

export interface FunctionDescriptor {
  readonly kind: "arrow" | "function";
  readonly async: boolean;
  readonly parameterCount: number;
  readonly returnType?: TypeNode;
  readonly body: FunctionBodyDescriptor;
  readonly span: SourceSpan;
}

export type DefineBeanOptionProperty =
  | {
      readonly kind: "create";
      readonly value: FunctionDescriptor | ExpressionValue;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "dispose";
      readonly value: FunctionDescriptor | ExpressionValue;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "primary";
      readonly value: ExpressionValue;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "qualifier";
      readonly value: ExpressionValue;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "scope";
      readonly value: ExpressionValue;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "unsupported-property";
      readonly propertyKind: "computed" | "spread" | "method" | "unknown-key";
      readonly span: SourceSpan;
    };

export type DefineBeanOptions =
  | {
      readonly kind: "object";
      readonly properties: readonly DefineBeanOptionProperty[];
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "unsupported";
      readonly expressionKind: UnsupportedExpressionKind;
      readonly span: SourceSpan;
    };

export interface DefineBeanDeclaration {
  readonly kind: "define-bean";
  readonly topLevel: boolean;
  readonly declarationKind: "const" | "let" | "var";
  readonly name?: string;
  readonly export: DeclarationExport;
  readonly callee: EntityName;
  readonly typeArguments: readonly TypeNode[];
  readonly options: DefineBeanOptions;
  readonly span: SourceSpan;
}

export type StartersArrayElement =
  | {
      readonly kind: "identifier";
      readonly name: string;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "unsupported-element";
      readonly expressionKind: UnsupportedExpressionKind;
      readonly span: SourceSpan;
    };

export type StartersOptionValue =
  | {
      readonly kind: "array";
      readonly elements: readonly StartersArrayElement[];
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "unsupported";
      readonly expressionKind: UnsupportedExpressionKind;
      readonly span: SourceSpan;
    };

export type DefineApplicationOptionProperty =
  | {
      readonly kind: "starters";
      readonly value: StartersOptionValue;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "unsupported-property";
      readonly propertyKind: "computed" | "spread" | "method" | "unknown-key";
      readonly span: SourceSpan;
    };

export type DefineApplicationOptions =
  | {
      readonly kind: "object";
      readonly properties: readonly DefineApplicationOptionProperty[];
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "unsupported";
      readonly expressionKind: UnsupportedExpressionKind;
      readonly span: SourceSpan;
    };

export interface DefineApplicationDeclaration {
  readonly kind: "define-application";
  readonly topLevel: boolean;
  // 调用结果没被绑定到任何地方，即写成了裸表达式语句。这种写法必须照常收进来：过去它在
  // 这一层就被丢掉，于是 build 成功、starter 一个都没注册、应用起来不监听任何端口，全程
  // 零诊断（Issue #261）。收进来才轮得到链接层去点名。
  readonly discarded: boolean;
  readonly name?: string;
  readonly export: DeclarationExport;
  readonly callee: EntityName;
  readonly options: DefineApplicationOptions;
  readonly span: SourceSpan;
}

// 顶层值声明的名录（ADR 0006 W3/W5，#152）：路由 marker 声明（const X = defineRouteMarker(...)）
// 与 schema 引用目标（export const UserSchema = ...）都要按名字回查"这个模块导出的这个值
// 是什么"。只登记形状，来源核实照旧留给链接/分析层。
export type ValueInitializer =
  // marker 识别只需要 callee 尾名与字面量实参。
  | {
      readonly kind: "call";
      readonly callee: EntityName;
      readonly arguments: readonly DecoratorArgumentValue[];
      readonly span: SourceSpan;
    }
  // schema 组声明（ADR 0006 W5）：@Get(path, schemas) 允许传一个指向顶层 const 对象字面量
  // 的标识符，handler 的 RequestContext<typeof X> 标注因此不必把整组 schema 类型重打一遍。
  | {
      readonly kind: "object-literal";
      readonly properties: readonly ObjectLiteralProperty[];
      readonly span: SourceSpan;
    };

export interface ValueDeclaration {
  readonly kind: "value-declaration";
  readonly topLevel: boolean;
  readonly declarationKind: "const" | "let" | "var";
  readonly name?: string;
  readonly export: DeclarationExport;
  readonly initializer?: ValueInitializer;
  readonly span: SourceSpan;
}

// 与 beanFactories 同一策略：parser 按尾名收集 ConfigProperties(...) 的变量初始化候选，
// 来源核实留给链接层——命中 @reforce/config 的候选即"中间变量"硬错（ADR 0005 决策 5.1）。
export interface ConfigFactoryCallDeclaration {
  readonly kind: "config-factory-call";
  readonly topLevel: boolean;
  readonly callee: EntityName;
  readonly span: SourceSpan;
}

export type UnsupportedNamedDeclarationKind =
  | "type-alias"
  | "enum"
  | "function"
  | "module-augmentation"
  | "import-alias"
  | "other";

export interface UnsupportedNamedDeclaration {
  readonly kind: "unsupported-named-declaration";
  readonly declarationKind: UnsupportedNamedDeclarationKind;
  readonly topLevel: boolean;
  readonly name?: string;
  readonly export: DeclarationExport;
  readonly generic: boolean;
  // 仅非泛型 type-alias 填（RFC 0012 S2，#274）：schema 追溯要跟"type X = z.infer<typeof s>"
  // 的别名右侧找 typeof。别名依旧不可注入、不改变链接语义——迁出 unsupportedDeclarations 会
  // 复发 #109 的导出可见性误诊断，所以只做附加字段。泛型别名追溯不到，维持无 rhs 的降级。
  readonly rhs?: TypeNode;
  readonly span: SourceSpan;
}

export interface SourceFileIr {
  // 抑制注释必须住进 IR（RFC 0011 D7，#242）：source-files.ts 的 LRU 以 [fileId, kind, sha256]
  // 缓存 SourceFileIr，命中时 parseSource 根本不执行——任何算在 parse 里但不进 IR 的东西，在
  // 缓存路径上就会凭空消失。
  readonly suppressions: readonly SuppressionComment[];
  readonly imports: readonly ImportDeclaration[];
  readonly exports: readonly ExportDeclaration[];
  readonly interfaces: readonly InterfaceDeclaration[];
  readonly namespaces: readonly NamespaceDeclaration[];
  readonly classes: readonly ClassDeclaration[];
  readonly beanFactories: readonly DefineBeanDeclaration[];
  readonly applicationDefinitions: readonly DefineApplicationDeclaration[];
  readonly configFactoryCalls: readonly ConfigFactoryCallDeclaration[];
  readonly valueDeclarations: readonly ValueDeclaration[];
  readonly unsupportedDeclarations: readonly UnsupportedNamedDeclaration[];
}
