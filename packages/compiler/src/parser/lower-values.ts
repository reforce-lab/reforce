import type {
  BaseNode,
  BindingPattern,
  Decorator,
  Expression,
  FunctionParameter,
  Node,
  NodeOfType,
  TSType,
} from "yuku-parser";
import { normalizeSpanned } from "@/parser/normalize";
import type {
  ConstructorParameter,
  DecoratorCallee,
  DecoratorUse,
  EntityName,
  ExpressionValue,
  FunctionBodyDescriptor,
  FunctionDescriptor,
  TypeNode,
  UnsupportedExpressionKind,
} from "@/parser/source-ir";
import type { SourceMapper, SourceSpan } from "@/parser/source-location";

export interface LoweringContext {
  readonly mapper: SourceMapper;
  readonly sourceText: string;
}

type FunctionLike = NodeOfType<
  "ArrowFunctionExpression" | "FunctionExpression" | "TSEmptyBodyFunctionExpression"
>;

type HeritageClause = NodeOfType<"TSClassImplements" | "TSInterfaceHeritage">;
type TypeInput = TSType | HeritageClause;

const unsupportedExpressionKinds = new Map<Node["type"], UnsupportedExpressionKind>([
  ["Identifier", "identifier"],
  ["CallExpression", "call"],
  ["MemberExpression", "member"],
  ["ConditionalExpression", "conditional"],
  ["ObjectExpression", "object"],
  ["ArrayExpression", "array"],
  ["TemplateLiteral", "template"],
  ["TaggedTemplateExpression", "template"],
  ["FunctionExpression", "function"],
  ["ArrowFunctionExpression", "function"],
  ["ClassExpression", "class"],
  ["NewExpression", "new"],
  ["AwaitExpression", "await"],
  ["YieldExpression", "yield"],
  ["AssignmentExpression", "assignment"],
  ["SequenceExpression", "sequence"],
  ["UnaryExpression", "unary"],
  ["BinaryExpression", "binary"],
  ["LogicalExpression", "logical"],
  ["UpdateExpression", "update"],
  ["ThisExpression", "this"],
  ["Super", "super"],
  ["JSXElement", "jsx"],
  ["JSXFragment", "jsx"],
]);

export function spanOf(node: BaseNode, context: LoweringContext): SourceSpan {
  return context.mapper.span(node.start, node.end);
}

export function identifierTextOf(node: Node | null | undefined): string | undefined {
  if (node?.type !== "Identifier") {
    return undefined;
  }
  return node.name;
}

function typeParameterDeclarationOf(
  owner: Node,
): NodeOfType<"TSTypeParameterDeclaration"> | null | undefined {
  switch (owner.type) {
    case "ArrowFunctionExpression":
    case "ClassDeclaration":
    case "ClassExpression":
    case "FunctionDeclaration":
    case "FunctionExpression":
      return owner.typeParameters;
    case "TSDeclareFunction":
    case "TSEmptyBodyFunctionExpression":
    case "TSFunctionType":
    case "TSConstructorType":
    case "TSInterfaceDeclaration":
    case "TSMethodSignature":
    case "TSTypeAliasDeclaration":
      return owner.typeParameters;
    default:
      return undefined;
  }
}

export function typeParameterNamesOf(owner: Node): ReadonlySet<string> {
  const declaration = typeParameterDeclarationOf(owner);
  return new Set(declaration?.params.map((parameter) => parameter.name.name) ?? []);
}

export function entityNameOf(
  node: Node | null | undefined,
  context: LoweringContext,
): EntityName | undefined {
  const identifier = identifierTextOf(node);
  if (identifier !== undefined && node !== null && node !== undefined) {
    return { kind: "identifier", name: identifier, span: spanOf(node, context) };
  }
  if (node?.type === "TSQualifiedName") {
    const left = entityNameOf(node.left, context);
    const right = identifierTextOf(node.right);
    if (left === undefined || right === undefined) {
      return undefined;
    }
    return { kind: "qualified", left, right, span: spanOf(node, context) };
  }
  if (node?.type !== "MemberExpression" || node.computed || node.property.type !== "Identifier") {
    return undefined;
  }
  const left = entityNameOf(node.object, context);
  const right = identifierTextOf(node.property);
  if (left === undefined || right === undefined) {
    return undefined;
  }
  return { kind: "qualified", left, right, span: spanOf(node, context) };
}

function typeArgumentsOf(
  owner:
    | NodeOfType<"TSTypeReference">
    | NodeOfType<"TSClassImplements">
    | NodeOfType<"TSInterfaceHeritage">,
): readonly TSType[] {
  return owner.typeArguments?.params ?? [];
}

export function typeNodeOf(
  node: TypeInput,
  context: LoweringContext,
  typeParameters: ReadonlySet<string> = new Set(),
): TypeNode {
  if (node.type === "TSParenthesizedType") {
    return typeNodeOf(node.typeAnnotation, context, typeParameters);
  }
  if (node.type === "TSVoidKeyword") {
    return { kind: "primitive", name: "void", span: spanOf(node, context) };
  }
  const reference = referenceTypeOf(node, context, typeParameters);
  if (reference !== undefined) {
    return reference;
  }
  return { kind: "unsupported", span: spanOf(node, context) };
}

function referenceTypeOf(
  node: TypeInput,
  context: LoweringContext,
  typeParameters: ReadonlySet<string>,
): TypeNode | undefined {
  if (node.type === "TSTypeReference") {
    const name = entityNameOf(node.typeName, context);
    if (name === undefined) {
      return { kind: "unsupported", span: spanOf(node, context) };
    }
    if (name.kind === "identifier" && typeParameters.has(name.name)) {
      return { kind: "unsupported", span: spanOf(node, context) };
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
  if (node.type === "TSClassImplements" || node.type === "TSInterfaceHeritage") {
    const name = entityNameOf(node.expression, context);
    if (name === undefined) {
      return { kind: "unsupported", span: spanOf(node, context) };
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
  return undefined;
}

export function expressionKindOf(node: Node): UnsupportedExpressionKind {
  if (node.type === "Literal") {
    if (typeof node.value === "number") {
      return "numeric";
    }
    if (typeof node.value === "bigint") {
      return "bigint";
    }
    if (node.value === null) {
      return "null";
    }
  }
  return unsupportedExpressionKinds.get(node.type) ?? "other";
}

export function expressionValueOf(node: Node, context: LoweringContext): ExpressionValue {
  if (node.type === "Literal" && typeof node.value === "string") {
    return { kind: "string-literal", value: node.value, span: spanOf(node, context) };
  }
  if (node.type === "Literal" && typeof node.value === "boolean") {
    return { kind: "boolean-literal", value: node.value, span: spanOf(node, context) };
  }
  return {
    kind: "unsupported",
    expressionKind: expressionKindOf(node),
    span: spanOf(node, context),
  };
}

function decoratorCalleeOf(
  node: Expression,
  context: LoweringContext,
): {
  readonly callee: DecoratorCallee;
  readonly called: boolean;
  readonly arguments: readonly ExpressionValue[];
} {
  if (node.type === "CallExpression") {
    const callee = entityNameOf(node.callee, context);
    return {
      callee: callee ?? {
        kind: "unsupported-expression",
        expressionKind: expressionKindOf(node.callee),
        span: spanOf(node.callee, context),
      },
      called: true,
      arguments: node.arguments.map((argument) => expressionValueOf(argument, context)),
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

export function decoratorsOf(
  decorators: readonly Decorator[],
  context: LoweringContext,
): readonly DecoratorUse[] {
  return normalizeSpanned(
    decorators.map((decorator) => ({
      kind: "decorator" as const,
      ...decoratorCalleeOf(decorator.expression, context),
      span: spanOf(decorator, context),
    })),
  );
}

interface ParameterShape {
  readonly node: BindingPattern;
  readonly optional: boolean;
  readonly rest: boolean;
  readonly hasInitializer: boolean;
  readonly decorators: readonly DecoratorUse[];
}

function parameterShapeOf(parameter: FunctionParameter, context: LoweringContext): ParameterShape {
  const outer = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
  const assignment = outer.type === "AssignmentPattern" ? outer : undefined;
  const rest = outer.type === "RestElement" ? outer : undefined;
  const node = parameterBindingOf(outer);
  const decoratorNodes = [
    ...(parameter.decorators ?? []),
    ...(outer === parameter ? [] : (outer.decorators ?? [])),
    ...(node === outer ? [] : (node.decorators ?? [])),
  ];
  return {
    node,
    optional: node.optional ?? false,
    rest: rest !== undefined,
    hasInitializer: assignment !== undefined,
    decorators: decoratorsOf(decoratorNodes, context),
  };
}

function parameterBindingOf(
  parameter: Exclude<FunctionParameter, NodeOfType<"TSParameterProperty">>,
): BindingPattern {
  if (parameter.type === "AssignmentPattern") {
    return parameter.left;
  }
  if (parameter.type === "RestElement") {
    return parameter.argument;
  }
  return parameter;
}

function parameterTypeNode(node: BindingPattern): TSType | undefined {
  return node.typeAnnotation?.typeAnnotation;
}

export function constructorParametersOf(
  owner: FunctionLike,
  context: LoweringContext,
  typeParameters: ReadonlySet<string>,
): readonly ConstructorParameter[] {
  return owner.params.map((parameter, index) => {
    const shape = parameterShapeOf(parameter, context);
    const type = parameterTypeNode(shape.node);
    return {
      kind: "constructor-parameter",
      index,
      type:
        type === undefined
          ? { kind: "unsupported", span: spanOf(parameter, context) }
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
  body: Expression | NodeOfType<"BlockStatement"> | null,
  context: LoweringContext,
): FunctionBodyDescriptor | undefined {
  if (body?.type === "NewExpression") {
    const callee = entityNameOf(body.callee, context);
    return callee === undefined
      ? undefined
      : { kind: "direct-new", callee, span: spanOf(body, context) };
  }
  if (body?.type !== "BlockStatement" || body.body.length !== 1) {
    return undefined;
  }
  const statement = body.body[0];
  const expression = statement?.type === "ReturnStatement" ? statement.argument : undefined;
  if (expression?.type !== "NewExpression") {
    return undefined;
  }
  const callee = entityNameOf(expression.callee, context);
  return callee === undefined
    ? undefined
    : { kind: "direct-new", callee, span: spanOf(expression, context) };
}

export function functionDescriptorOf(
  node: Node,
  context: LoweringContext,
): FunctionDescriptor | undefined {
  if (node.type !== "ArrowFunctionExpression" && node.type !== "FunctionExpression") {
    return undefined;
  }
  const typeParameters = typeParameterNamesOf(node);
  const direct = directNewBodyOf(node.body, context);
  const returnType = node.returnType?.typeAnnotation;
  return {
    kind: node.type === "ArrowFunctionExpression" ? "arrow" : "function",
    async: node.async,
    parameterCount: node.params.length,
    ...(returnType === undefined
      ? {}
      : { returnType: typeNodeOf(returnType, context, typeParameters) }),
    body: direct ?? {
      kind: "unsupported",
      expressionKind: node.body === null ? "other" : expressionKindOf(node.body),
      span: node.body === null ? spanOf(node, context) : spanOf(node.body, context),
    },
    span: spanOf(node, context),
  };
}

export function sourceKeywordSpan(
  node: BaseNode,
  name: BaseNode | null | undefined,
  keyword: string,
  context: LoweringContext,
): SourceSpan {
  const before = name?.start ?? node.end;
  const start = context.sourceText.lastIndexOf(keyword, before);
  if (start < node.start || start < 0) {
    return spanOf(node, context);
  }
  return context.mapper.span(start, node.end);
}
