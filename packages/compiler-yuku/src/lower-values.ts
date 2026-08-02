import type {
  ConstructorParameter,
  DecoratorCallee,
  DecoratorUse,
  EntityName,
  ExpressionValue,
  FunctionBodyDescriptor,
  FunctionDescriptor,
  FunctionParameterDescriptor,
  IdentifierName,
  PrimitiveTypeName,
  SourceSpan,
  TypeNode,
  TypeParameterDeclaration,
  UnsupportedExpressionKind,
  UnsupportedTypeReason,
} from "@reforce/compiler-spi";
import {
  type AstNode,
  booleanProperty,
  nodeArrayProperty,
  nodeProperty,
  stringProperty,
} from "./ast";
import { normalizeSpanned } from "./normalize";
import type { SourceMapper } from "./source-map";

export interface LoweringContext {
  readonly mapper: SourceMapper;
  readonly sourceText: string;
}

export function spanOf(node: AstNode, context: LoweringContext): SourceSpan {
  return context.mapper.span(node.start, node.end);
}

export function identifierOf(
  node: AstNode | undefined,
  context: LoweringContext,
): IdentifierName | undefined {
  if (node?.type !== "Identifier") {
    return undefined;
  }
  const text = stringProperty(node, "name");
  if (text === undefined) {
    return undefined;
  }
  return { text, span: spanOf(node, context) };
}

function identifierFromTypeParameter(
  node: AstNode,
  context: LoweringContext,
): IdentifierName | undefined {
  const nameNode = nodeProperty(node, "name");
  const identifier = identifierOf(nameNode, context);
  if (identifier !== undefined) {
    return identifier;
  }
  const text = stringProperty(node, "name");
  if (text === undefined) {
    return undefined;
  }
  return {
    text,
    span: context.mapper.span(node.start, node.start + text.length),
  };
}

export function typeParametersOf(
  owner: AstNode,
  context: LoweringContext,
): readonly TypeParameterDeclaration[] {
  const declaration = nodeProperty(owner, "typeParameters");
  if (declaration === undefined) {
    return [];
  }
  return nodeArrayProperty(declaration, "params").flatMap((parameter) => {
    const name = identifierFromTypeParameter(parameter, context);
    return name === undefined ? [] : [{ name, span: spanOf(parameter, context) }];
  });
}

export function typeParameterNamesOf(owner: AstNode): ReadonlySet<string> {
  const declaration = nodeProperty(owner, "typeParameters");
  if (declaration === undefined) {
    return new Set();
  }
  return new Set(
    nodeArrayProperty(declaration, "params").flatMap((parameter) => {
      const nameNode = nodeProperty(parameter, "name");
      const name = nameNode ? stringProperty(nameNode, "name") : stringProperty(parameter, "name");
      return name === undefined ? [] : [name];
    }),
  );
}

export function entityNameOf(
  node: AstNode | undefined,
  context: LoweringContext,
): EntityName | undefined {
  const identifier = identifierOf(node, context);
  if (identifier !== undefined && node !== undefined) {
    return { kind: "identifier", name: identifier, span: spanOf(node, context) };
  }
  if (node === undefined || !isQualifiedEntity(node)) {
    return undefined;
  }
  const left = entityNameOf(
    nodeProperty(node, node.type === "TSQualifiedName" ? "left" : "object"),
    context,
  );
  const right = identifierOf(
    nodeProperty(node, node.type === "TSQualifiedName" ? "right" : "property"),
    context,
  );
  if (left === undefined || right === undefined) {
    return undefined;
  }
  return { kind: "qualified", left, right, span: spanOf(node, context) };
}

function isQualifiedEntity(node: AstNode): boolean {
  if (node.type === "TSQualifiedName") {
    return true;
  }
  return (
    (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") &&
    !booleanProperty(node, "computed")
  );
}

function primitiveName(type: string): PrimitiveTypeName | undefined {
  const names: Readonly<Record<string, PrimitiveTypeName>> = {
    TSStringKeyword: "string",
    TSNumberKeyword: "number",
    TSBooleanKeyword: "boolean",
    TSBigIntKeyword: "bigint",
    TSSymbolKeyword: "symbol",
    TSUndefinedKeyword: "undefined",
    TSNullKeyword: "null",
    TSVoidKeyword: "void",
    TSNeverKeyword: "never",
    TSUnknownKeyword: "unknown",
    TSAnyKeyword: "any",
  };
  return names[type];
}

function typeArgumentsOf(node: AstNode): readonly AstNode[] {
  const owner = nodeProperty(node, "typeArguments") ?? nodeProperty(node, "typeParameters");
  return owner === undefined ? [] : nodeArrayProperty(owner, "params");
}

function unsupportedTypeReason(type: string): UnsupportedTypeReason {
  const reasons: Readonly<Record<string, UnsupportedTypeReason>> = {
    TSTypeLiteral: "anonymous-object",
    TSObjectKeyword: "anonymous-object",
    TSFunctionType: "function",
    TSLiteralType: "literal",
    TSConditionalType: "conditional",
    TSMappedType: "mapped",
    TSIndexedAccessType: "indexed-access",
    TSTypeQuery: "type-query",
    TSImportType: "import-type",
    TSInferType: "infer",
    TSConstructorType: "constructor",
    TSTypePredicate: "predicate",
  };
  return reasons[type] ?? "other";
}

function transparentTypeNode(node: AstNode): AstNode | undefined {
  if (
    node.type === "TSTypeAnnotation" ||
    node.type === "TSParenthesizedType" ||
    node.type === "TSOptionalType" ||
    node.type === "TSRestType"
  ) {
    return nodeProperty(node, "typeAnnotation");
  }
  return undefined;
}

function readonlyTypeOf(
  node: AstNode,
  context: LoweringContext,
  typeParameters: ReadonlySet<string>,
): TypeNode {
  const innerNode = nodeProperty(node, "typeAnnotation");
  if (innerNode === undefined) {
    return { kind: "unsupported", reason: "other", span: spanOf(node, context) };
  }
  const inner = typeNodeOf(innerNode, context, typeParameters);
  if (stringProperty(node, "operator") !== "readonly") {
    return { kind: "unsupported", reason: "other", span: spanOf(node, context) };
  }
  if (inner.kind === "array") {
    return { ...inner, readonly: true, span: spanOf(node, context) };
  }
  if (inner.kind === "tuple") {
    return { ...inner, readonly: true, span: spanOf(node, context) };
  }
  return { kind: "unsupported", reason: "other", span: spanOf(node, context) };
}

export function typeNodeOf(
  node: AstNode,
  context: LoweringContext,
  typeParameters: ReadonlySet<string> = new Set(),
): TypeNode {
  const transparent = transparentTypeNode(node);
  if (transparent !== undefined) {
    return typeNodeOf(transparent, context, typeParameters);
  }
  const primitive = primitiveName(node.type);
  if (primitive !== undefined) {
    return { kind: "primitive", name: primitive, span: spanOf(node, context) };
  }
  if (node.type === "TSTypeReference") {
    return typeReferenceOf(node, context, typeParameters);
  }
  if (
    node.type === "TSExpressionWithTypeArguments" ||
    node.type === "TSClassImplements" ||
    node.type === "TSInterfaceHeritage"
  ) {
    return expressionTypeOf(node, context, typeParameters);
  }
  if (node.type === "TSUnionType" || node.type === "TSIntersectionType") {
    const kind = node.type === "TSUnionType" ? "union" : "intersection";
    return {
      kind,
      members: normalizeSpanned(
        nodeArrayProperty(node, "types").map((member) =>
          typeNodeOf(member, context, typeParameters),
        ),
      ),
      span: spanOf(node, context),
    };
  }
  if (node.type === "TSArrayType") {
    const element = nodeProperty(node, "elementType");
    return {
      kind: "array",
      element: element
        ? typeNodeOf(element, context, typeParameters)
        : { kind: "unsupported", reason: "other", span: spanOf(node, context) },
      readonly: false,
      span: spanOf(node, context),
    };
  }
  if (node.type === "TSTupleType") {
    return {
      kind: "tuple",
      elements: nodeArrayProperty(node, "elementTypes").map((element) =>
        typeNodeOf(element, context, typeParameters),
      ),
      readonly: false,
      span: spanOf(node, context),
    };
  }
  if (node.type === "TSTypeOperator") {
    return readonlyTypeOf(node, context, typeParameters);
  }
  return {
    kind: "unsupported",
    reason: unsupportedTypeReason(node.type),
    span: spanOf(node, context),
  };
}

function typeReferenceOf(
  node: AstNode,
  context: LoweringContext,
  typeParameters: ReadonlySet<string>,
): TypeNode {
  const name = entityNameOf(nodeProperty(node, "typeName"), context);
  if (name === undefined) {
    return { kind: "unsupported", reason: "other", span: spanOf(node, context) };
  }
  if (name.kind === "identifier" && typeParameters.has(name.name.text)) {
    return { kind: "type-parameter", name: name.name, span: spanOf(node, context) };
  }
  return {
    kind: "reference",
    name,
    typeArguments: typeArgumentsOf(node).map((argument) =>
      typeNodeOf(argument, context, typeParameters),
    ),
    span: spanOf(node, context),
  };
}

function expressionTypeOf(
  node: AstNode,
  context: LoweringContext,
  typeParameters: ReadonlySet<string>,
): TypeNode {
  const name = entityNameOf(nodeProperty(node, "expression"), context);
  if (name === undefined) {
    return { kind: "unsupported", reason: "other", span: spanOf(node, context) };
  }
  return {
    kind: "reference",
    name,
    typeArguments: typeArgumentsOf(node).map((argument) =>
      typeNodeOf(argument, context, typeParameters),
    ),
    span: spanOf(node, context),
  };
}

export function expressionKindOf(node: AstNode): UnsupportedExpressionKind {
  const kinds: Readonly<Record<string, UnsupportedExpressionKind>> = {
    Identifier: "identifier",
    CallExpression: "call",
    OptionalCallExpression: "call",
    MemberExpression: "member",
    OptionalMemberExpression: "member",
    ConditionalExpression: "conditional",
    ObjectExpression: "object",
    ArrayExpression: "array",
    TemplateLiteral: "template",
    TaggedTemplateExpression: "template",
    NumericLiteral: "numeric",
    DecimalLiteral: "numeric",
    BigIntLiteral: "bigint",
    NullLiteral: "null",
    FunctionExpression: "function",
    ArrowFunctionExpression: "function",
    ClassExpression: "class",
    NewExpression: "new",
    AwaitExpression: "await",
    YieldExpression: "yield",
    AssignmentExpression: "assignment",
    SequenceExpression: "sequence",
    UnaryExpression: "unary",
    BinaryExpression: "binary",
    LogicalExpression: "logical",
    UpdateExpression: "update",
    ThisExpression: "this",
    Super: "super",
    JSXElement: "jsx",
    JSXFragment: "jsx",
  };
  if (node.type === "Literal") {
    const value = node.value;
    if (typeof value === "number") {
      return "numeric";
    }
    if (typeof value === "bigint") {
      return "bigint";
    }
    if (value === null) {
      return "null";
    }
  }
  return kinds[node.type] ?? "other";
}

export function expressionValueOf(node: AstNode, context: LoweringContext): ExpressionValue {
  if (
    node.type === "StringLiteral" ||
    (node.type === "Literal" && typeof node.value === "string")
  ) {
    const value = node.value;
    if (typeof value === "string") {
      return { kind: "string-literal", value, span: spanOf(node, context) };
    }
  }
  if (
    node.type === "BooleanLiteral" ||
    (node.type === "Literal" && typeof node.value === "boolean")
  ) {
    const value = node.value;
    if (typeof value === "boolean") {
      return { kind: "boolean-literal", value, span: spanOf(node, context) };
    }
  }
  return {
    kind: "unsupported",
    expressionKind: expressionKindOf(node),
    span: spanOf(node, context),
  };
}

function decoratorCalleeOf(
  node: AstNode,
  context: LoweringContext,
): {
  readonly callee: DecoratorCallee;
  readonly called: boolean;
  readonly arguments: readonly ExpressionValue[];
} {
  if (node.type === "CallExpression" || node.type === "OptionalCallExpression") {
    const target = nodeProperty(node, "callee");
    const callee = entityNameOf(target, context);
    return {
      callee: callee ?? {
        kind: "unsupported-expression",
        expressionKind: target ? expressionKindOf(target) : "other",
        span: target ? spanOf(target, context) : spanOf(node, context),
      },
      called: true,
      arguments: nodeArrayProperty(node, "arguments").map((argument) =>
        expressionValueOf(argument, context),
      ),
    };
  }
  const callee = entityNameOf(node, context);
  return {
    callee: callee ?? {
      kind: "unsupported-expression",
      expressionKind: expressionKindOf(node),
      span: spanOf(node, context),
    },
    called: false,
    arguments: [],
  };
}

export function decoratorsOf(owner: AstNode, context: LoweringContext): readonly DecoratorUse[] {
  return normalizeSpanned(
    nodeArrayProperty(owner, "decorators").flatMap((decorator) => {
      const expression = nodeProperty(decorator, "expression");
      if (expression === undefined) {
        return [];
      }
      return [
        {
          kind: "decorator",
          ...decoratorCalleeOf(expression, context),
          span: spanOf(decorator, context),
        },
      ];
    }),
  );
}

interface ParameterShape {
  readonly node: AstNode;
  readonly optional: boolean;
  readonly rest: boolean;
  readonly hasInitializer: boolean;
  readonly decorators: readonly DecoratorUse[];
}

function parameterShapeOf(parameter: AstNode, context: LoweringContext): ParameterShape {
  const parameterProperty =
    parameter.type === "TSParameterProperty" ? nodeProperty(parameter, "parameter") : undefined;
  const outer = parameterProperty ?? parameter;
  const assignment = outer.type === "AssignmentPattern" ? nodeProperty(outer, "left") : undefined;
  const rest = outer.type === "RestElement" ? nodeProperty(outer, "argument") : undefined;
  const node = assignment ?? rest ?? outer;
  return {
    node,
    optional: booleanProperty(node, "optional"),
    rest: rest !== undefined,
    hasInitializer: assignment !== undefined,
    decorators: [
      ...decoratorsOf(parameter, context),
      ...(outer === parameter ? [] : decoratorsOf(outer, context)),
      ...(node === outer ? [] : decoratorsOf(node, context)),
    ],
  };
}

function parameterTypeNode(node: AstNode): AstNode | undefined {
  const annotation = nodeProperty(node, "typeAnnotation");
  return annotation?.type === "TSTypeAnnotation"
    ? nodeProperty(annotation, "typeAnnotation")
    : annotation;
}

export function functionParametersOf(
  owner: AstNode,
  context: LoweringContext,
  typeParameters: ReadonlySet<string>,
): readonly FunctionParameterDescriptor[] {
  return nodeArrayProperty(owner, "params").map((parameter, index) => {
    const shape = parameterShapeOf(parameter, context);
    const type = parameterTypeNode(shape.node);
    return {
      index,
      ...(type === undefined ? {} : { type: typeNodeOf(type, context, typeParameters) }),
      optional: shape.optional,
      rest: shape.rest,
      hasInitializer: shape.hasInitializer,
      span: spanOf(parameter, context),
    };
  });
}

export function constructorParametersOf(
  owner: AstNode,
  context: LoweringContext,
  typeParameters: ReadonlySet<string>,
): readonly ConstructorParameter[] {
  return nodeArrayProperty(owner, "params").map((parameter, index) => {
    const shape = parameterShapeOf(parameter, context);
    const type = parameterTypeNode(shape.node);
    return {
      kind: "constructor-parameter",
      index,
      type:
        type === undefined
          ? { kind: "unsupported", reason: "other", span: spanOf(parameter, context) }
          : typeNodeOf(type, context, typeParameters),
      optional: shape.optional,
      rest: shape.rest,
      hasInitializer: shape.hasInitializer,
      decorators: shape.decorators,
      span: spanOf(parameter, context),
    };
  });
}

function directNewBodyOf(
  body: AstNode,
  context: LoweringContext,
): FunctionBodyDescriptor | undefined {
  if (body.type === "NewExpression") {
    const callee = entityNameOf(nodeProperty(body, "callee"), context);
    return callee === undefined
      ? undefined
      : { kind: "direct-new", callee, span: spanOf(body, context) };
  }
  if (body.type !== "BlockStatement") {
    return undefined;
  }
  const statements = nodeArrayProperty(body, "body");
  const expression =
    statements.length === 1 ? nodeProperty(statements[0] ?? body, "argument") : undefined;
  if (statements[0]?.type !== "ReturnStatement" || expression?.type !== "NewExpression") {
    return undefined;
  }
  const callee = entityNameOf(nodeProperty(expression, "callee"), context);
  return callee === undefined
    ? undefined
    : { kind: "direct-new", callee, span: spanOf(expression, context) };
}

export function functionDescriptorOf(
  node: AstNode,
  context: LoweringContext,
): FunctionDescriptor | undefined {
  if (node.type !== "ArrowFunctionExpression" && node.type !== "FunctionExpression") {
    return undefined;
  }
  const typeParameters = typeParameterNamesOf(node);
  const body = nodeProperty(node, "body");
  const direct = body ? directNewBodyOf(body, context) : undefined;
  const returnAnnotation = nodeProperty(node, "returnType");
  const returnType = returnAnnotation
    ? (nodeProperty(returnAnnotation, "typeAnnotation") ?? returnAnnotation)
    : undefined;
  return {
    kind: node.type === "ArrowFunctionExpression" ? "arrow" : "function",
    async: booleanProperty(node, "async"),
    parameters: functionParametersOf(node, context, typeParameters),
    ...(returnType === undefined
      ? {}
      : { returnType: typeNodeOf(returnType, context, typeParameters) }),
    body: direct ?? {
      kind: "unsupported",
      expressionKind: body ? expressionKindOf(body) : "other",
      span: body ? spanOf(body, context) : spanOf(node, context),
    },
    span: spanOf(node, context),
  };
}

export function sourceKeywordSpan(
  node: AstNode,
  keyword: string,
  context: LoweringContext,
): SourceSpan {
  const name = nodeProperty(node, "id");
  const before = name?.start ?? node.end;
  const start = context.sourceText.lastIndexOf(keyword, before);
  if (start < node.start || start < 0) {
    return spanOf(node, context);
  }
  return context.mapper.span(start, node.end);
}
