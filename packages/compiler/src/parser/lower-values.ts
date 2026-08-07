import type {
  BaseNode,
  BindingPattern,
  Decorator,
  Expression,
  FunctionParameter,
  Node,
  NodeOfType,
  ObjectPropertyKind,
  TSType,
} from "yuku-parser";
import { normalizeSpanned } from "@/parser/normalize";
import type {
  ConstructorParameter,
  DecoratorArgumentValue,
  DecoratorCallee,
  DecoratorUse,
  EntityName,
  ExpressionValue,
  FunctionBodyDescriptor,
  FunctionDescriptor,
  MethodParameter,
  ObjectLiteralProperty,
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

// 槽位解析（RFC 0012 S2，#274）在语法层裁决"裸标量当键名"，这 6 个关键字都要可表达；
// undefined 服务可选单键（Header<"x" | undefined>）。
const PRIMITIVE_KEYWORD_TYPES = new Map<
  Node["type"],
  "void" | "string" | "number" | "bigint" | "boolean" | "undefined"
>([
  ["TSVoidKeyword", "void"],
  ["TSStringKeyword", "string"],
  ["TSNumberKeyword", "number"],
  ["TSBigIntKeyword", "bigint"],
  ["TSBooleanKeyword", "boolean"],
  ["TSUndefinedKeyword", "undefined"],
]);

// 只有字符串字面量参与槽位形态裁决（Param<"id">，#274）；数字/模板等字面量类型照旧 unsupported。
function literalTypeNodeOf(node: NodeOfType<"TSLiteralType">, context: LoweringContext): TypeNode {
  if (node.literal.type === "Literal" && typeof node.literal.value === "string") {
    return { kind: "string-literal", value: node.literal.value, span: spanOf(node, context) };
  }
  return { kind: "unsupported", span: spanOf(node, context) };
}

// typeof X（#274 schema 追溯）；typeof import(...) 没有可链接的标识符，落 unsupported。
function typeQueryNodeOf(node: NodeOfType<"TSTypeQuery">, context: LoweringContext): TypeNode {
  const name =
    node.exprName.type === "TSImportType" ? undefined : entityNameOf(node.exprName, context);
  if (name !== undefined) {
    return { kind: "type-query", name, span: spanOf(node, context) };
  }
  return { kind: "unsupported", span: spanOf(node, context) };
}

export function typeNodeOf(
  node: TypeInput,
  context: LoweringContext,
  typeParameters: ReadonlySet<string> = new Set(),
): TypeNode {
  if (node.type === "TSParenthesizedType") {
    return typeNodeOf(node.typeAnnotation, context, typeParameters);
  }
  const primitive = PRIMITIVE_KEYWORD_TYPES.get(node.type);
  if (primitive !== undefined) {
    return { kind: "primitive", name: primitive, span: spanOf(node, context) };
  }
  if (node.type === "TSLiteralType") {
    return literalTypeNodeOf(node, context);
  }
  if (node.type === "TSUnionType") {
    return {
      kind: "union",
      members: node.types.map((member) => typeNodeOf(member, context, typeParameters)),
      span: spanOf(node, context),
    };
  }
  if (node.type === "TSTypeQuery") {
    return typeQueryNodeOf(node, context);
  }
  if (node.type === "TSArrayType") {
    return {
      kind: "array",
      element: typeNodeOf(node.elementType, context, typeParameters),
      readonlyModifier: false,
      span: spanOf(node, context),
    };
  }
  // readonly 只对数组形态有意义；keyof/unique 以及作用在非数组上的 readonly 照旧 unsupported。
  if (node.type === "TSTypeOperator" && node.operator === "readonly") {
    const inner = unparenthesizedType(node.typeAnnotation);
    if (inner.type === "TSArrayType") {
      return {
        kind: "array",
        element: typeNodeOf(inner.elementType, context, typeParameters),
        readonlyModifier: true,
        span: spanOf(node, context),
      };
    }
  }
  const reference = referenceTypeOf(node, context, typeParameters);
  if (reference !== undefined) {
    return reference;
  }
  return { kind: "unsupported", span: spanOf(node, context) };
}

function unparenthesizedType(node: TSType): TSType {
  let current = node;
  while (current.type === "TSParenthesizedType") {
    current = current.typeAnnotation;
  }
  return current;
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
  const numeric = numberLiteralOf(target, context);
  if (numeric !== undefined) {
    return numeric;
  }
  return {
    kind: "unsupported",
    expressionKind: expressionKindOf(target),
    span: spanOf(target, context),
  };
}

// 数字字面量允许一元负号（@Order(-1) 在 AST 里是 UnaryExpression 包字面量）；其余一元运算不认。
function numberLiteralOf(target: Node, context: LoweringContext): ExpressionValue | undefined {
  if (target.type === "Literal" && typeof target.value === "number") {
    return { kind: "number-literal", value: target.value, span: spanOf(target, context) };
  }
  if (target.type === "UnaryExpression" && target.operator === "-") {
    const operand = unparenthesized(target.argument);
    if (operand.type === "Literal" && typeof operand.value === "number") {
      return { kind: "number-literal", value: -operand.value, span: spanOf(target, context) };
    }
  }
  return undefined;
}

export function objectLiteralPropertyOf(
  property: ObjectPropertyKind,
  context: LoweringContext,
): ObjectLiteralProperty {
  if (property.type === "SpreadElement") {
    return {
      kind: "unsupported-property",
      propertyKind: "spread",
      span: spanOf(property, context),
    };
  }
  if (property.computed) {
    return {
      kind: "unsupported-property",
      propertyKind: "computed",
      span: spanOf(property, context),
    };
  }
  if (property.method) {
    return {
      kind: "unsupported-property",
      propertyKind: "method",
      span: spanOf(property, context),
    };
  }
  const key =
    identifierTextOf(property.key) ??
    (property.key.type === "Literal" && typeof property.key.value === "string"
      ? property.key.value
      : undefined);
  if (key === undefined) {
    return {
      kind: "unsupported-property",
      propertyKind: "computed",
      span: spanOf(property, context),
    };
  }
  return {
    kind: "property",
    key,
    value: decoratorArgumentValueOf(property.value, context),
    span: spanOf(property, context),
  };
}

// 装饰器参数位的放宽形态（ADR 0006 W3/W5）：JSON 字面量树（marker 值）+ 标识符引用
// （schema / 中间件类）。数组空洞没有节点，落在数组 span 上按 unsupported 处理；其余
// 表达式照旧走窄的 expressionValueOf 分类。
export function decoratorArgumentValueOf(
  node: Node,
  context: LoweringContext,
): DecoratorArgumentValue {
  const target = unparenthesized(node);
  if (target.type === "Literal" && target.value === null) {
    return { kind: "null-literal", span: spanOf(target, context) };
  }
  if (target.type === "ArrayExpression") {
    return {
      kind: "array-literal",
      elements: target.elements.map((element): DecoratorArgumentValue => {
        // 数组空洞（[a, , b]）没有自己的节点，只能挂在数组 span 上；spread 不是静态字面量。
        if (element === null) {
          return { kind: "unsupported", expressionKind: "other", span: spanOf(target, context) };
        }
        if (element.type === "SpreadElement") {
          return { kind: "unsupported", expressionKind: "other", span: spanOf(element, context) };
        }
        return decoratorArgumentValueOf(element, context);
      }),
      span: spanOf(target, context),
    };
  }
  if (target.type === "ObjectExpression") {
    return {
      kind: "object-literal",
      properties: target.properties.map((property) => objectLiteralPropertyOf(property, context)),
      span: spanOf(target, context),
    };
  }
  if (target.type === "Identifier" || target.type === "MemberExpression") {
    const entity = entityNameOf(target, context);
    if (entity !== undefined) {
      return { kind: "identifier-reference", entity, span: spanOf(target, context) };
    }
  }
  return expressionValueOf(target, context);
}

function decoratorCalleeOf(
  node: Expression,
  context: LoweringContext,
): {
  readonly callee: DecoratorCallee;
  readonly called: boolean;
  readonly arguments: readonly DecoratorArgumentValue[];
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
      arguments: target.arguments.map((argument) => decoratorArgumentValueOf(argument, context)),
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

// 路由 handler 的逐参数槽位解析入口（RFC 0012 S2，#274）。name/nameSpan 只对标识符模式存在；
// nameSpan 截到名字本身（Identifier 节点的 span 含类型标注，而 checker 位置查询必须锚在参数
// 名上——查类型注解位对 error type 拿不到东西）。
export function methodParametersOf(
  owner: FunctionLike,
  context: LoweringContext,
  typeParameters: ReadonlySet<string>,
): readonly MethodParameter[] {
  return owner.params.map((parameter, index) => {
    const shape = parameterShapeOf(parameter, context);
    const outer = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
    // rest 参数的类型标注挂在 RestElement 上而不是内部 Identifier 上。
    const type =
      parameterTypeNode(shape.node) ??
      (outer.type === "RestElement" ? outer.typeAnnotation?.typeAnnotation : undefined);
    const name = identifierTextOf(shape.node);
    return {
      kind: "method-parameter",
      index,
      ...(name === undefined
        ? {}
        : {
            name,
            nameSpan: context.mapper.span(shape.node.start, shape.node.start + name.length),
          }),
      ...(type === undefined ? {} : { typeAnnotation: typeNodeOf(type, context, typeParameters) }),
      optional: shape.optional,
      rest: shape.rest,
      hasInitializer: shape.hasInitializer,
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
