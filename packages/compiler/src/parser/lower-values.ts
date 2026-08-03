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

// Parentheses change nothing about what an expression means, but the parser keeps them as their own
// node, so a classifier that only looks at `node.type` sees `ParenthesizedExpression` and gives up:
// `(defineBean)(...)` used to produce neither IR nor a diagnostic. Every classifier that dispatches
// on `node.type` must therefore call this first, otherwise parentheses are transparent in one form
// and fatal in its sibling. Only parentheses are unwrapped: the type-level wrappers (`as`,
// `satisfies`, `!`) restate what a value is, which is exactly what provided-type inference reads, so
// looking through them would change the DI graph in ways nobody has decided on.
export function unparenthesized(node: Node): Node {
  let current = node;
  while (current.type === "ParenthesizedExpression") {
    current = current.expression;
  }
  return current;
}

export function entityNameOf(
  node: Node | null | undefined,
  context: LoweringContext,
): EntityName | undefined {
  if (node === null || node === undefined) {
    return undefined;
  }
  const target = unparenthesized(node);
  if (target.type === "Identifier") {
    return { kind: "identifier", name: target.name, span: spanOf(target, context) };
  }
  if (target.type === "TSQualifiedName") {
    const left = entityNameOf(target.left, context);
    const right = identifierTextOf(target.right);
    if (left === undefined || right === undefined) {
      return undefined;
    }
    return { kind: "qualified", left, right, span: spanOf(target, context) };
  }
  if (
    target.type !== "MemberExpression" ||
    target.computed ||
    target.property.type !== "Identifier"
  ) {
    return undefined;
  }
  const left = entityNameOf(target.object, context);
  const right = identifierTextOf(target.property);
  if (left === undefined || right === undefined) {
    return undefined;
  }
  return { kind: "qualified", left, right, span: spanOf(target, context) };
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
  const target = unparenthesized(node);
  if (target.type === "Literal") {
    if (typeof target.value === "number") {
      return "numeric";
    }
    if (typeof target.value === "bigint") {
      return "bigint";
    }
    if (target.value === null) {
      return "null";
    }
  }
  return unsupportedExpressionKinds.get(target.type) ?? "other";
}

export function expressionValueOf(node: Node, context: LoweringContext): ExpressionValue {
  const target = unparenthesized(node);
  if (target.type === "Literal" && typeof target.value === "string") {
    return { kind: "string-literal", value: target.value, span: spanOf(target, context) };
  }
  if (target.type === "Literal" && typeof target.value === "boolean") {
    return { kind: "boolean-literal", value: target.value, span: spanOf(target, context) };
  }
  return {
    kind: "unsupported",
    expressionKind: expressionKindOf(target),
    span: spanOf(target, context),
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
  const target = unparenthesized(node);
  if (target.type === "CallExpression") {
    const callee = entityNameOf(target.callee, context);
    return {
      callee: callee ?? {
        kind: "unsupported-expression",
        expressionKind: expressionKindOf(target.callee),
        span: spanOf(target.callee, context),
      },
      called: true,
      arguments: target.arguments.map((argument) => expressionValueOf(argument, context)),
    };
  }
  const callee = entityNameOf(target, context);
  return {
    callee: callee ?? {
      kind: "unsupported-expression",
      expressionKind: expressionKindOf(target),
      span: spanOf(target, context),
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
  // Decorators may sit on any of the unwrapping levels (TSParameterProperty, AssignmentPattern /
  // RestElement, binding pattern); identity-dedupe keeps each level's decorators exactly once.
  const levels = [...new Set([parameter, outer, node])];
  const decoratorNodes = levels.flatMap((level) => level.decorators ?? []);
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

function returnedExpressionOf(body: NodeOfType<"BlockStatement">): Expression | null | undefined {
  if (body.body.length !== 1) {
    return undefined;
  }
  const statement = body.body[0];
  return statement?.type === "ReturnStatement" ? statement.argument : undefined;
}

function directNewBodyOf(
  body: Expression | NodeOfType<"BlockStatement"> | null,
  context: LoweringContext,
): FunctionBodyDescriptor | undefined {
  const returned = body?.type === "BlockStatement" ? returnedExpressionOf(body) : body;
  if (returned === null || returned === undefined) {
    return undefined;
  }
  const expression = unparenthesized(returned);
  if (expression.type !== "NewExpression") {
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
  const target = unparenthesized(node);
  if (target.type !== "ArrowFunctionExpression" && target.type !== "FunctionExpression") {
    return undefined;
  }
  const typeParameters = typeParameterNamesOf(target);
  const direct = directNewBodyOf(target.body, context);
  const returnType = target.returnType?.typeAnnotation;
  return {
    kind: target.type === "ArrowFunctionExpression" ? "arrow" : "function",
    async: target.async,
    parameterCount: target.params.length,
    ...(returnType === undefined
      ? {}
      : { returnType: typeNodeOf(returnType, context, typeParameters) }),
    body: direct ?? {
      kind: "unsupported",
      expressionKind: target.body === null ? "other" : expressionKindOf(target.body),
      span: target.body === null ? spanOf(target, context) : spanOf(target.body, context),
    },
    span: spanOf(target, context),
  };
}

export function sourceKeywordSpan(
  node: BaseNode,
  follower: BaseNode,
  keyword: string,
  context: LoweringContext,
): SourceSpan {
  // node.start lands on a leading decorator or the `export` modifier, but the IR contract pins
  // declaration spans to the declaration keyword (class/interface/namespace), so locate the
  // keyword by searching backwards from the first child that must follow it. The bound has to be
  // a child that always exists: an anonymous class has no name, and widening the window to
  // node.end lets the class body win the match ("classify", "className", a doc comment) — see
  // issue #107.
  const start = context.sourceText.lastIndexOf(keyword, follower.start);
  if (start < node.start) {
    return spanOf(node, context);
  }
  return context.mapper.span(start, node.end);
}
