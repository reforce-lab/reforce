import type { SourceSpan } from "@/parser/source-location";

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
      readonly kind: "primitive";
      readonly name: "void";
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

export interface DecoratorUse {
  readonly kind: "decorator";
  readonly callee: DecoratorCallee;
  readonly called: boolean;
  readonly arguments: readonly ExpressionValue[];
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

export interface ClassMethodDeclaration {
  readonly kind: "method";
  readonly name: ClassMethodName;
  readonly static: boolean;
  readonly accessibility: "public" | "protected" | "private";
  readonly async: boolean;
  readonly generator: boolean;
  readonly optional: boolean;
  readonly implementation: boolean;
  readonly parameterCount: number;
  readonly returnType?: TypeNode;
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
  readonly name?: string;
  readonly export: DeclarationExport;
  readonly callee: EntityName;
  readonly options: DefineApplicationOptions;
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
  readonly span: SourceSpan;
}

export interface SourceFileIr {
  readonly imports: readonly ImportDeclaration[];
  readonly exports: readonly ExportDeclaration[];
  readonly interfaces: readonly InterfaceDeclaration[];
  readonly namespaces: readonly NamespaceDeclaration[];
  readonly classes: readonly ClassDeclaration[];
  readonly beanFactories: readonly DefineBeanDeclaration[];
  readonly applicationDefinitions: readonly DefineApplicationDeclaration[];
  readonly configFactoryCalls: readonly ConfigFactoryCallDeclaration[];
  readonly unsupportedDeclarations: readonly UnsupportedNamedDeclaration[];
}
