import type { FrontendInput } from "#internal/frontend";
import type { CanonicalFileId, SourceSpan } from "#internal/source-location";

export interface IdentifierName {
  readonly text: string;
  readonly span: SourceSpan;
}

export interface ModuleSpecifier {
  readonly text: string;
  readonly span: SourceSpan;
}

export type EntityName =
  | {
      readonly kind: "identifier";
      readonly name: IdentifierName;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "qualified";
      readonly left: EntityName;
      readonly right: IdentifierName;
      readonly span: SourceSpan;
    };

export type PrimitiveTypeName =
  | "string"
  | "number"
  | "boolean"
  | "bigint"
  | "symbol"
  | "undefined"
  | "null"
  | "void"
  | "never"
  | "unknown"
  | "any";

export type UnsupportedTypeReason =
  | "anonymous-object"
  | "function"
  | "literal"
  | "conditional"
  | "mapped"
  | "indexed-access"
  | "type-query"
  | "import-type"
  | "infer"
  | "constructor"
  | "predicate"
  | "other";

export type TypeNode =
  | {
      readonly kind: "reference";
      readonly name: EntityName;
      readonly typeArguments: readonly TypeNode[];
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "union";
      readonly members: readonly TypeNode[];
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "intersection";
      readonly members: readonly TypeNode[];
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "array";
      readonly element: TypeNode;
      readonly readonly: boolean;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "tuple";
      readonly elements: readonly TypeNode[];
      readonly readonly: boolean;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "primitive";
      readonly name: PrimitiveTypeName;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "type-parameter";
      readonly name: IdentifierName;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "unsupported";
      readonly reason: UnsupportedTypeReason;
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
      readonly exportedName: IdentifierName;
      readonly span: SourceSpan;
    }
  | { readonly kind: "default-only"; readonly span: SourceSpan };

export type ImportBinding =
  | {
      readonly kind: "default";
      readonly local: IdentifierName;
      readonly typeOnly: boolean;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "namespace";
      readonly local: IdentifierName;
      readonly typeOnly: boolean;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "named";
      readonly imported: IdentifierName;
      readonly local: IdentifierName;
      readonly typeOnly: boolean;
      readonly span: SourceSpan;
    };

export type ImportDeclaration =
  | {
      readonly kind: "import";
      readonly moduleSpecifier: ModuleSpecifier;
      readonly typeOnly: boolean;
      readonly bindings: readonly ImportBinding[];
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "unsupported-import";
      readonly syntaxKind: "import-equals" | "attributes" | "other";
      readonly span: SourceSpan;
    };

export interface ExportSpecifier {
  readonly local: IdentifierName;
  readonly exported: IdentifierName;
  readonly typeOnly: boolean;
  readonly span: SourceSpan;
}

export type ExportDeclaration =
  | {
      readonly kind: "local-named";
      readonly typeOnly: boolean;
      readonly specifiers: readonly ExportSpecifier[];
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "reexport-named";
      readonly moduleSpecifier: ModuleSpecifier;
      readonly typeOnly: boolean;
      readonly specifiers: readonly ExportSpecifier[];
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "reexport-all";
      readonly moduleSpecifier: ModuleSpecifier;
      readonly typeOnly: boolean;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "namespace";
      readonly moduleSpecifier: ModuleSpecifier;
      readonly exported: IdentifierName;
      readonly typeOnly: boolean;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "default-local";
      readonly local: IdentifierName;
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

export interface TypeParameterDeclaration {
  readonly name: IdentifierName;
  readonly span: SourceSpan;
}

export interface InterfaceDeclaration {
  readonly kind: "interface";
  readonly topLevel: boolean;
  readonly name?: IdentifierName;
  readonly export: DeclarationExport;
  readonly typeParameters: readonly TypeParameterDeclaration[];
  readonly extends: readonly TypeNode[];
  readonly span: SourceSpan;
}

export type NamespaceMemberKind = "type" | "value" | "namespace";

export interface NamespaceExportedMember {
  readonly kind: NamespaceMemberKind;
  readonly name: IdentifierName;
  readonly span: SourceSpan;
}

export interface NamespaceDeclaration {
  readonly kind: "namespace";
  readonly topLevel: boolean;
  readonly name: IdentifierName;
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
  | { readonly kind: "identifier"; readonly name: IdentifierName }
  | {
      readonly kind: "string-literal";
      readonly value: string;
      readonly span: SourceSpan;
    }
  | { readonly kind: "computed"; readonly span: SourceSpan };

export interface FunctionParameterDescriptor {
  readonly index: number;
  readonly type?: TypeNode;
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
  readonly parameters: readonly FunctionParameterDescriptor[];
  readonly returnType?: TypeNode;
  readonly span: SourceSpan;
}

export interface ClassDeclaration {
  readonly kind: "class";
  readonly topLevel: boolean;
  readonly abstract: boolean;
  readonly name?: IdentifierName;
  readonly export: DeclarationExport;
  readonly typeParameters: readonly TypeParameterDeclaration[];
  readonly decorators: readonly DecoratorUse[];
  readonly implements: readonly TypeNode[];
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
  readonly parameters: readonly FunctionParameterDescriptor[];
  readonly returnType?: TypeNode;
  readonly body: FunctionBodyDescriptor;
  readonly span: SourceSpan;
}

export type DefineBeanOptionProperty =
  | {
      readonly kind: "create";
      readonly keySpan: SourceSpan;
      readonly value: FunctionDescriptor | ExpressionValue;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "dispose";
      readonly keySpan: SourceSpan;
      readonly value: FunctionDescriptor | ExpressionValue;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "primary";
      readonly keySpan: SourceSpan;
      readonly value: ExpressionValue;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "qualifier";
      readonly keySpan: SourceSpan;
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
  readonly name?: IdentifierName;
  readonly export: DeclarationExport;
  readonly callee: EntityName;
  readonly typeArguments: readonly TypeNode[];
  readonly options: DefineBeanOptions;
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
  readonly name?: IdentifierName;
  readonly export: DeclarationExport;
  readonly typeParameters: readonly TypeParameterDeclaration[];
  readonly span: SourceSpan;
}

export interface SourceUnit {
  readonly kind: "source-unit";
  readonly file: CanonicalFileId;
  readonly sourceKind: FrontendInput["sourceKind"];
  readonly imports: readonly ImportDeclaration[];
  readonly exports: readonly ExportDeclaration[];
  readonly interfaces: readonly InterfaceDeclaration[];
  readonly namespaces: readonly NamespaceDeclaration[];
  readonly classes: readonly ClassDeclaration[];
  readonly beanFactories: readonly DefineBeanDeclaration[];
  readonly unsupportedDeclarations: readonly UnsupportedNamedDeclaration[];
}
