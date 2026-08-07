import { type AliasMap, is, nameOf } from "yuku-ast";
import type {
  ArrayExpression,
  ArrayExpressionElement,
  BaseNode,
  CallExpression,
  Class,
  Comment,
  Declaration,
  Directive,
  ExpressionStatement,
  ImportDeclarationSpecifier,
  ModuleDeclaration,
  Node,
  NodeOfType,
  ObjectPropertyKind,
  ExportAllDeclaration as ParserExportAllDeclaration,
  ExportDefaultDeclaration as ParserExportDefaultDeclaration,
  ExportNamedDeclaration as ParserExportNamedDeclaration,
  ExportSpecifier as ParserExportSpecifier,
  ImportDeclaration as ParserImportDeclaration,
  Program,
  ProgramStatement,
  StringLiteral,
  TSModuleDeclaration,
  VariableDeclaration,
  VariableDeclarator,
} from "yuku-parser";
import {
  constructorParametersOf,
  decoratorArgumentValueOf,
  decoratorsOf,
  entityNameOf,
  expressionKindOf,
  expressionValueOf,
  functionDescriptorOf,
  identifierTextOf,
  type LoweringContext,
  methodParametersOf,
  objectLiteralPropertyOf,
  sourceKeywordSpan,
  spanOf,
  typeNodeOf,
  typeParameterNamesOf,
  unparenthesized,
} from "@/parser/lower-values";
import { normalizeSpanned } from "@/parser/normalize";
import type {
  ClassDeclaration,
  ClassFieldDeclaration,
  ClassHeritage,
  ClassMethodDeclaration,
  ClassMethodName,
  ConfigFactoryCallDeclaration,
  ConstructorDeclaration,
  DeclarationExport,
  DefineApplicationDeclaration,
  DefineApplicationOptionProperty,
  DefineApplicationOptions,
  DefineBeanDeclaration,
  DefineBeanOptionProperty,
  DefineBeanOptions,
  EntityName,
  ExportDeclaration,
  ExportSpecifier,
  ImportBinding,
  ImportDeclaration,
  InterfaceDeclaration,
  NamespaceDeclaration,
  NamespaceExportedMember,
  NamespaceMemberKind,
  SourceFileIr,
  StartersArrayElement,
  StartersOptionValue,
  UnsupportedNamedDeclaration,
  UnsupportedNamedDeclarationKind,
  ValueDeclaration,
  ValueInitializer,
} from "@/parser/source-ir";
import type { CanonicalFileId } from "@/parser/source-location";
import { createSourceMapper } from "@/parser/source-location";
import { collectSuppressions } from "@/parser/suppressions";

type ExportMode =
  | { readonly kind: "none" }
  | { readonly kind: "named"; readonly owner: BaseNode }
  | { readonly kind: "default-only"; readonly owner: BaseNode };

interface Collector {
  readonly imports: ImportDeclaration[];
  readonly exports: ExportDeclaration[];
  readonly interfaces: InterfaceDeclaration[];
  readonly namespaces: NamespaceDeclaration[];
  readonly classes: ClassDeclaration[];
  readonly beanFactories: DefineBeanDeclaration[];
  readonly applicationDefinitions: DefineApplicationDeclaration[];
  readonly configFactoryCalls: ConfigFactoryCallDeclaration[];
  readonly valueDeclarations: ValueDeclaration[];
  readonly unsupportedDeclarations: UnsupportedNamedDeclaration[];
}

// 别名组由 parser 的 AST 定义生成，parser 新增方法节点类型时这里自动跟随；手写成员列表会漂移
// （Issue #91）。同理，模块声明的判定用 `is.ModuleDeclaration` 而非手写 type 列表。
type ClassMethod = AliasMap["Method"];
type FunctionNode = AliasMap["Function"];

// 这 5 个节点类型在 parser 里不构成任何 alias group（Issue #91 / PR #93 已确认），只能手写一份名单。
// 名单同时是类型来源、kind 映射和成员判定：谓词那份 `||` 链改名单时 tsc 不会报错，只有表能把三处钉死
// （Issue #114）。
const UNSUPPORTED_DECLARATION_KINDS = {
  FunctionDeclaration: "function",
  TSDeclareFunction: "function",
  TSEnumDeclaration: "enum",
  TSImportEqualsDeclaration: "import-alias",
  TSTypeAliasDeclaration: "type-alias",
} as const satisfies Record<string, UnsupportedNamedDeclarationKind>;

type UnsupportedDeclaration = NodeOfType<keyof typeof UNSUPPORTED_DECLARATION_KINDS>;

function declarationExportOf(
  name: Node | null | undefined,
  mode: ExportMode,
  context: LoweringContext,
): DeclarationExport {
  if (mode.kind === "none") {
    return { kind: "none" };
  }
  if (mode.kind === "default-only") {
    return { kind: "default-only", span: spanOf(mode.owner, context) };
  }
  const exportedName = identifierTextOf(name);
  if (exportedName === undefined) {
    return { kind: "none" };
  }
  return { kind: "named", exportedName, span: spanOf(mode.owner, context) };
}

function moduleSpecifierOf(source: StringLiteral): string {
  return source.value;
}

function importBindingOf(
  specifier: ImportDeclarationSpecifier,
  context: LoweringContext,
): ImportBinding {
  const local = specifier.local.name;
  if (specifier.type === "ImportDefaultSpecifier") {
    return { kind: "default", local, span: spanOf(specifier, context) };
  }
  if (specifier.type === "ImportNamespaceSpecifier") {
    return { kind: "namespace", local, span: spanOf(specifier, context) };
  }
  return {
    kind: "named",
    imported: nameOf(specifier.imported),
    local,
    span: spanOf(specifier, context),
  };
}

function lowerImport(
  node: ParserImportDeclaration | NodeOfType<"TSImportEqualsDeclaration">,
  collector: Collector,
  context: LoweringContext,
): void {
  if (node.type === "TSImportEqualsDeclaration") {
    collector.imports.push({
      kind: "unsupported-import",
      syntaxKind: "import-equals",
      span: spanOf(node, context),
    });
    return;
  }
  if (node.attributes.length > 0) {
    collector.imports.push({
      kind: "unsupported-import",
      syntaxKind: "attributes",
      span: spanOf(node, context),
    });
    return;
  }
  collector.imports.push({
    kind: "import",
    moduleSpecifier: moduleSpecifierOf(node.source),
    bindings: normalizeSpanned(
      node.specifiers.map((specifier) => importBindingOf(specifier, context)),
    ),
    span: spanOf(node, context),
  });
}

function exportSpecifierOf(node: ParserExportSpecifier, context: LoweringContext): ExportSpecifier {
  return {
    local: nameOf(node.local),
    exported: nameOf(node.exported),
    span: spanOf(node, context),
  };
}

function lowerNamedExport(
  node: ParserExportNamedDeclaration,
  collector: Collector,
  context: LoweringContext,
): void {
  if (node.attributes.length > 0) {
    collector.exports.push({
      kind: "unsupported-export",
      syntaxKind: "attributes",
      span: spanOf(node, context),
    });
    return;
  }
  const specifiers = node.specifiers.map((specifier) => exportSpecifierOf(specifier, context));
  if (node.source === null) {
    collector.exports.push({
      kind: "local-named",
      specifiers,
      span: spanOf(node, context),
    });
    return;
  }
  collector.exports.push({
    kind: "reexport-named",
    moduleSpecifier: moduleSpecifierOf(node.source),
    specifiers,
    span: spanOf(node, context),
  });
}

function lowerExportAll(
  node: ParserExportAllDeclaration,
  collector: Collector,
  context: LoweringContext,
): void {
  if (node.attributes.length > 0) {
    collector.exports.push({
      kind: "unsupported-export",
      syntaxKind: "attributes",
      span: spanOf(node, context),
    });
    return;
  }
  const moduleSpecifier = moduleSpecifierOf(node.source);
  if (node.exported === null) {
    collector.exports.push({
      kind: "reexport-all",
      moduleSpecifier,
      span: spanOf(node, context),
    });
    return;
  }
  collector.exports.push({
    kind: "namespace",
    moduleSpecifier,
    exported: nameOf(node.exported),
    span: spanOf(node, context),
  });
}

function lowerDefaultExport(
  node: ParserExportDefaultDeclaration,
  collector: Collector,
  context: LoweringContext,
): void {
  const local = identifierTextOf(unparenthesized(node.declaration));
  if (local !== undefined) {
    collector.exports.push({ kind: "default-local", local, span: spanOf(node, context) });
    return;
  }
  collector.exports.push({
    kind: "default-expression",
    expressionKind: expressionKindOf(node.declaration),
    span: spanOf(node, context),
  });
}

function classMethodNameOf(method: ClassMethod, context: LoweringContext): ClassMethodName {
  if (method.computed) {
    return { kind: "computed", span: spanOf(method.key, context) };
  }
  const identifier = identifierTextOf(method.key);
  if (identifier !== undefined) {
    return { kind: "identifier", name: identifier };
  }
  if (method.key.type === "Literal" && typeof method.key.value === "string") {
    return {
      kind: "string-literal",
      value: method.key.value,
      span: spanOf(method.key, context),
    };
  }
  return { kind: "computed", span: spanOf(method.key, context) };
}

function accessibilityOf(method: ClassMethod): "public" | "protected" | "private" {
  return method.accessibility ?? "public";
}

function classMethodOf(
  method: ClassMethod,
  context: LoweringContext,
  classTypeParameters: ReadonlySet<string>,
): ClassMethodDeclaration | undefined {
  if (method.kind !== "method") {
    return undefined;
  }
  const value = method.value;
  const methodTypeParameters = new Set([...classTypeParameters, ...typeParameterNamesOf(value)]);
  const returnType = value.returnType?.typeAnnotation;
  return {
    kind: "method",
    name: classMethodNameOf(method, context),
    static: method.static,
    accessibility: accessibilityOf(method),
    async: value.async,
    generator: value.generator,
    optional: method.optional ?? false,
    implementation: value.body?.type === "BlockStatement",
    parameters: methodParametersOf(value, context, methodTypeParameters),
    ...(returnType === undefined
      ? {}
      : { returnType: typeNodeOf(returnType, context, methodTypeParameters) }),
    decorators: decoratorsOf(method.decorators ?? [], context),
    span: spanOf(method, context),
  };
}

function constructorOf(
  method: ClassMethod,
  context: LoweringContext,
  typeParameters: ReadonlySet<string>,
): ConstructorDeclaration | undefined {
  if (method.kind !== "constructor") {
    return undefined;
  }
  return {
    kind: "constructor",
    accessibility: accessibilityOf(method),
    implementation: method.value.body?.type === "BlockStatement",
    parameters: constructorParametersOf(method.value, context, typeParameters),
    span: spanOf(method, context),
  };
}

// 这 4 个类字段节点类型没有 alias group，与 UNSUPPORTED_DECLARATION_KINDS 同理只能手写一份名单
// （Issue #91 / #114 的表驱动纪律）。
const CLASS_FIELD_TYPES = new Set<Node["type"]>([
  "PropertyDefinition",
  "TSAbstractPropertyDefinition",
  "AccessorProperty",
  "TSAbstractAccessorProperty",
]);

type ClassFieldNode = NodeOfType<
  | "PropertyDefinition"
  | "TSAbstractPropertyDefinition"
  | "AccessorProperty"
  | "TSAbstractAccessorProperty"
>;

function isClassField(node: Node): node is ClassFieldNode {
  return CLASS_FIELD_TYPES.has(node.type);
}

function classFieldNameOf(field: ClassFieldNode): string | undefined {
  if (field.computed) {
    return undefined;
  }
  if (field.key.type === "Literal" && typeof field.key.value === "string") {
    return field.key.value;
  }
  return identifierTextOf(field.key);
}

function classFieldOf(field: ClassFieldNode, context: LoweringContext): ClassFieldDeclaration {
  const name = classFieldNameOf(field);
  return {
    kind: "class-field",
    ...(name === undefined ? {} : { name }),
    static: field.static,
    span: spanOf(field, context),
  };
}

// heritage 里出现的所有标识符名都收进来（含成员访问的属性名，宁多勿漏）：分析层只用它回答
// "这个非直接调用的 extends 表达式是否引用了 ConfigProperties"，多收的名字最多造成一次多余的
// 符号解析，漏收则复刻 #54 的静默跳过。
function collectIdentifierNames(node: unknown, names: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectIdentifierNames(item, names);
    }
    return;
  }
  if (node === null || typeof node !== "object") {
    return;
  }
  const type = Reflect.get(node, "type");
  if (type === "Identifier") {
    const name = Reflect.get(node, "name");
    if (typeof name === "string") {
      names.add(name);
    }
  }
  for (const value of Object.values(node)) {
    collectIdentifierNames(value, names);
  }
}

function heritageExpressionOf(superClass: Node, context: LoweringContext): ClassHeritage {
  const names = new Set<string>();
  collectIdentifierNames(superClass, names);
  return {
    kind: "expression",
    referencedNames: [...names].sort(),
    span: spanOf(superClass, context),
  };
}

function classHeritageOf(
  superClass: Node | null | undefined,
  context: LoweringContext,
): ClassHeritage | undefined {
  if (superClass === null || superClass === undefined) {
    return undefined;
  }
  const target = unparenthesized(superClass);
  const parenthesized = target !== superClass;
  if (target.type === "CallExpression") {
    const callee = entityNameOf(target.callee, context);
    if (callee === undefined) {
      return heritageExpressionOf(superClass, context);
    }
    return {
      kind: "call",
      callee,
      arguments: target.arguments.map((argument) => expressionValueOf(argument, context)),
      parenthesized,
      span: spanOf(superClass, context),
    };
  }
  const entity = entityNameOf(target, context);
  if (entity === undefined) {
    return heritageExpressionOf(superClass, context);
  }
  return { kind: "reference", entity, parenthesized, span: spanOf(superClass, context) };
}

function lowerClass(
  node: Class,
  topLevel: boolean,
  mode: ExportMode,
  collector: Collector,
  context: LoweringContext,
): void {
  const typeParameters = typeParameterNamesOf(node);
  const methods = node.body.body.filter(is.Method);
  const heritage = classHeritageOf(node.superClass, context);
  const name = identifierTextOf(node.id);
  collector.classes.push({
    kind: "class",
    topLevel,
    abstract: node.abstract ?? false,
    name,
    export: declarationExportOf(node.id, mode, context),
    generic: typeParameters.size > 0,
    decorators: decoratorsOf(node.decorators, context),
    ...(heritage === undefined ? {} : { heritage }),
    fields: normalizeSpanned(
      node.body.body.filter(isClassField).map((field) => classFieldOf(field, context)),
    ),
    implements: normalizeSpanned(
      (node.implements ?? []).map((implemented) =>
        typeNodeOf(implemented, context, typeParameters),
      ),
    ),
    constructors: normalizeSpanned(
      methods.flatMap((method) => {
        const declaration = constructorOf(method, context, typeParameters);
        return declaration === undefined ? [] : [declaration];
      }),
    ),
    methods: normalizeSpanned(
      methods.flatMap((method) => {
        const declaration = classMethodOf(method, context, typeParameters);
        return declaration === undefined ? [] : [declaration];
      }),
    ),
    span: sourceKeywordSpan(
      node,
      node.id ?? node.typeParameters ?? node.superClass ?? node.implements?.[0] ?? node.body,
      "class",
      context,
    ),
  });
  for (const method of methods) {
    visitFunctionBody(method.value, collector, context);
  }
}

function lowerInterface(
  node: NodeOfType<"TSInterfaceDeclaration">,
  topLevel: boolean,
  mode: ExportMode,
  collector: Collector,
  context: LoweringContext,
): void {
  const typeParameters = typeParameterNamesOf(node);
  collector.interfaces.push({
    kind: "interface",
    topLevel,
    name: node.id.name,
    export: declarationExportOf(node.id, mode, context),
    generic: typeParameters.size > 0,
    extends: normalizeSpanned(
      node.extends.map((extended) => typeNodeOf(extended, context, typeParameters)),
    ),
    span: sourceKeywordSpan(node, node.id, "interface", context),
  });
}

function declarationNameOf(declaration: Declaration): string | undefined {
  return "id" in declaration ? identifierTextOf(declaration.id) : undefined;
}

function namespaceMemberKind(declaration: Declaration): NamespaceMemberKind {
  if (
    declaration.type === "TSInterfaceDeclaration" ||
    declaration.type === "TSTypeAliasDeclaration" ||
    (declaration.type === "TSImportEqualsDeclaration" && declaration.importKind === "type")
  ) {
    return "type";
  }
  return declaration.type === "TSModuleDeclaration" ? "namespace" : "value";
}

function namespaceMembersOf(
  node: TSModuleDeclaration,
  context: LoweringContext,
): readonly NamespaceExportedMember[] {
  return normalizeSpanned(
    (node.body?.body ?? []).flatMap((statement) => {
      if (statement.type !== "ExportNamedDeclaration") {
        return [];
      }
      if (statement.declaration !== null) {
        const name = declarationNameOf(statement.declaration);
        return name === undefined
          ? []
          : [
              {
                kind: namespaceMemberKind(statement.declaration),
                name,
                span: spanOf(statement, context),
              },
            ];
      }
      return statement.specifiers.map((specifier) => ({
        kind: "value" as const,
        name: nameOf(specifier.exported),
        span: spanOf(specifier, context),
      }));
    }),
  );
}

function lowerNamespace(
  node: TSModuleDeclaration,
  topLevel: boolean,
  mode: ExportMode,
  collector: Collector,
  context: LoweringContext,
): void {
  if (node.id.type === "Literal") {
    // `declare module "pkg" { … }` 描述的是另一个模块的形状。在这里 lower 它的 body 会把那些声明登记到本
    // 文件名下（project-linker 按 source.fileId 组织 localSymbols），于是 compiler 会链接到被增强模块
    // 根本没导出的名字。让它停在 unsupported 上，用户至少拿到可操作的 TYPE_LINK_FAILED（Issue #113）。
    lowerUnsupported(node, "module-augmentation", topLevel, mode, collector, context);
    return;
  }
  // 只有点号命名空间（`namespace A.B { … }`，id 是 TSQualifiedName）没有单一承载名。它不是 augmentation，
  // body 就是普通的文件内代码，照 `namespace A { namespace B { … } }` 的方式遍历（Issue #113）。
  const name = identifierTextOf(node.id);
  if (name !== undefined) {
    collector.namespaces.push({
      kind: "namespace",
      topLevel,
      name,
      export: declarationExportOf(node.id, mode, context),
      exportedMembers: namespaceMembersOf(node, context),
      span: sourceKeywordSpan(node, node.id, "namespace", context),
    });
  }
  for (const statement of node.body?.body ?? []) {
    visitStatement(statement, false, { kind: "none" }, collector, context);
  }
}

function defineBeanOptionsOf(node: Node, context: LoweringContext): DefineBeanOptions {
  const target = unparenthesized(node);
  if (target.type !== "ObjectExpression") {
    return {
      kind: "unsupported",
      expressionKind: expressionKindOf(target),
      span: spanOf(target, context),
    };
  }
  return {
    kind: "object",
    properties: target.properties.map((property) => defineBeanOptionOf(property, context)),
    span: spanOf(target, context),
  };
}

function defineBeanOptionOf(
  property: ObjectPropertyKind,
  context: LoweringContext,
): DefineBeanOptionProperty {
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
  const keyName =
    identifierTextOf(property.key) ??
    (property.key.type === "Literal" && typeof property.key.value === "string"
      ? property.key.value
      : undefined);
  if (!isDefineBeanKey(keyName)) {
    return {
      kind: "unsupported-property",
      propertyKind: "unknown-key",
      span: spanOf(property, context),
    };
  }
  if (keyName === "create" || keyName === "dispose") {
    return {
      kind: keyName,
      value:
        functionDescriptorOf(property.value, context) ?? expressionValueOf(property.value, context),
      span: spanOf(property, context),
    };
  }
  return {
    kind: keyName,
    value: expressionValueOf(property.value, context),
    span: spanOf(property, context),
  };
}

function isDefineBeanKey(
  value: string | undefined,
): value is "create" | "dispose" | "primary" | "qualifier" | "scope" {
  return (
    value === "create" ||
    value === "dispose" ||
    value === "primary" ||
    value === "qualifier" ||
    value === "scope"
  );
}

function entityTail(entity: EntityName | undefined): string | undefined {
  if (entity === undefined) {
    return undefined;
  }
  return entity.kind === "identifier" ? entity.name : entity.right;
}

// defineBean / defineApplication 都按"callee 尾名"识别调用，命名空间前缀（`di.defineBean(...)`）
// 留给链接层核实来源。
function calledByTailName(
  node: Node,
  tail: string,
  context: LoweringContext,
): { readonly call: CallExpression; readonly callee: EntityName } | undefined {
  const call = unparenthesized(node);
  if (call.type !== "CallExpression") {
    return undefined;
  }
  const callee = entityNameOf(call.callee, context);
  if (callee === undefined || entityTail(callee) !== tail) {
    return undefined;
  }
  return { call, callee };
}

function lowerBeanFactory(
  declaration: VariableDeclaration,
  declarator: VariableDeclarator,
  topLevel: boolean,
  mode: ExportMode,
  collector: Collector,
  context: LoweringContext,
): void {
  const init = declarator.init;
  if (init === null || init === undefined) {
    return;
  }
  const matched = calledByTailName(init, "defineBean", context);
  if (matched === undefined) {
    return;
  }
  const { call, callee } = matched;
  const options = call.arguments[0];
  const name = identifierTextOf(declarator.id);
  collector.beanFactories.push({
    kind: "define-bean",
    topLevel,
    declarationKind: variableDeclarationKind(declaration),
    name,
    export: declarationExportOf(declarator.id, mode, context),
    callee,
    typeArguments: (call.typeArguments?.params ?? []).map((argument) =>
      typeNodeOf(argument, context),
    ),
    options:
      options === undefined
        ? { kind: "unsupported", expressionKind: "other", span: spanOf(call, context) }
        : defineBeanOptionsOf(options, context),
    span: spanOf(declarator, context),
  });
}

function variableDeclarationKind(node: VariableDeclaration): "const" | "let" | "var" {
  return node.kind === "let" || node.kind === "var" ? node.kind : "const";
}

// 值声明名录（ADR 0006 W3/W5，#152）：marker 声明与 schema 引用目标都按"模块 × 名字"回查。
// init 只在直接调用与对象字面量两种形态下保真（marker 识别需要 callee 尾名 + 字面量实参；
// schema 组需要属性表）；解构等无单一承载名的声明不进名录——它们无法被具名 import 引用为
// schema/marker。
// 只在 schema 组这一条路径上看穿 as / satisfies / !：`{ params: p } as const` 与
// `{ params: p }` 是同一个对象字面量，路由表提取读的是属性表本身。unparenthesized 的注释
// 拒绝看穿类型层包装，针对的是 DI 的 provided-type 推断——那里包装确实改变"这个值是什么"，
// 这里不改变。marker 的 call 形态照旧不放宽。
function withoutTypeWrappers(node: Node): Node {
  let current = node;
  while (
    current.type === "TSAsExpression" ||
    current.type === "TSSatisfiesExpression" ||
    current.type === "TSNonNullExpression" ||
    current.type === "TSTypeAssertion" ||
    current.type === "ParenthesizedExpression"
  ) {
    current = current.expression;
  }
  return current;
}

function valueInitializerOf(
  init: Node | undefined,
  context: LoweringContext,
): ValueInitializer | undefined {
  if (init === undefined) {
    return undefined;
  }
  const object = withoutTypeWrappers(init);
  if (object.type === "ObjectExpression") {
    return {
      kind: "object-literal",
      properties: object.properties.map((property) => objectLiteralPropertyOf(property, context)),
      span: spanOf(object, context),
    };
  }
  const callee = init.type === "CallExpression" ? entityNameOf(init.callee, context) : undefined;
  if (init.type !== "CallExpression" || callee === undefined) {
    return undefined;
  }
  return {
    kind: "call",
    callee,
    arguments: init.arguments.map((argument) => decoratorArgumentValueOf(argument, context)),
    span: spanOf(init, context),
  };
}

function lowerValueDeclaration(
  declaration: VariableDeclaration,
  declarator: VariableDeclarator,
  topLevel: boolean,
  mode: ExportMode,
  collector: Collector,
  context: LoweringContext,
): void {
  const name = identifierTextOf(declarator.id);
  if (name === undefined) {
    return;
  }
  const init =
    declarator.init === null || declarator.init === undefined
      ? undefined
      : unparenthesized(declarator.init);
  const initializer = valueInitializerOf(init, context);
  collector.valueDeclarations.push({
    kind: "value-declaration",
    topLevel,
    declarationKind: variableDeclarationKind(declaration),
    name,
    export: declarationExportOf(declarator.id, mode, context),
    ...(initializer === undefined ? {} : { initializer }),
    span: spanOf(declarator, context),
  });
}

function lowerConfigFactoryCall(
  declarator: VariableDeclarator,
  topLevel: boolean,
  collector: Collector,
  context: LoweringContext,
): void {
  const init = declarator.init;
  if (init === null || init === undefined) {
    return;
  }
  const matched = calledByTailName(init, "ConfigProperties", context);
  if (matched === undefined) {
    return;
  }
  collector.configFactoryCalls.push({
    kind: "config-factory-call",
    topLevel,
    callee: matched.callee,
    span: spanOf(declarator, context),
  });
}

// ADR 0004 决策 5（Issue #120）：defineApplication 的 starters 只支持标识符数组字面量。其余形状照
// defineBean 的惯例 lower 成 unsupported 而不是丢弃，让分析层在原位置给出可操作的诊断。
function startersElementOf(
  element: ArrayExpressionElement,
  array: ArrayExpression,
  context: LoweringContext,
): StartersArrayElement {
  // 数组空洞（`[a, , b]`）没有自己的节点，只能挂在数组的 span 上。
  if (element === null) {
    return { kind: "unsupported-element", expressionKind: "other", span: spanOf(array, context) };
  }
  if (element.type === "SpreadElement") {
    return { kind: "unsupported-element", expressionKind: "other", span: spanOf(element, context) };
  }
  const target = unparenthesized(element);
  if (target.type === "Identifier") {
    return { kind: "identifier", name: target.name, span: spanOf(target, context) };
  }
  return {
    kind: "unsupported-element",
    expressionKind: expressionKindOf(target),
    span: spanOf(target, context),
  };
}

function startersValueOf(node: Node, context: LoweringContext): StartersOptionValue {
  const target = unparenthesized(node);
  if (target.type !== "ArrayExpression") {
    return {
      kind: "unsupported",
      expressionKind: expressionKindOf(target),
      span: spanOf(target, context),
    };
  }
  return {
    kind: "array",
    elements: target.elements.map((element) => startersElementOf(element, target, context)),
    span: spanOf(target, context),
  };
}

function defineApplicationOptionOf(
  property: ObjectPropertyKind,
  context: LoweringContext,
): DefineApplicationOptionProperty {
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
  const keyName =
    identifierTextOf(property.key) ??
    (property.key.type === "Literal" && typeof property.key.value === "string"
      ? property.key.value
      : undefined);
  if (keyName !== "starters") {
    return {
      kind: "unsupported-property",
      propertyKind: "unknown-key",
      span: spanOf(property, context),
    };
  }
  return {
    kind: "starters",
    value: startersValueOf(property.value, context),
    span: spanOf(property, context),
  };
}

function defineApplicationOptionsOf(
  call: CallExpression,
  context: LoweringContext,
): DefineApplicationOptions {
  const argument = call.arguments[0];
  if (argument === undefined) {
    return { kind: "unsupported", expressionKind: "other", span: spanOf(call, context) };
  }
  const target = unparenthesized(argument);
  if (target.type !== "ObjectExpression") {
    return {
      kind: "unsupported",
      expressionKind: expressionKindOf(target),
      span: spanOf(target, context),
    };
  }
  return {
    kind: "object",
    properties: target.properties.map((property) => defineApplicationOptionOf(property, context)),
    span: spanOf(target, context),
  };
}

function lowerApplicationDefinition(
  declarator: VariableDeclarator,
  topLevel: boolean,
  mode: ExportMode,
  collector: Collector,
  context: LoweringContext,
): void {
  const init = declarator.init;
  if (init === null || init === undefined) {
    return;
  }
  const matched = calledByTailName(init, "defineApplication", context);
  if (matched === undefined) {
    return;
  }
  const name = identifierTextOf(declarator.id);
  collector.applicationDefinitions.push({
    kind: "define-application",
    topLevel,
    discarded: false,
    name,
    export: declarationExportOf(declarator.id, mode, context),
    callee: matched.callee,
    options: defineApplicationOptionsOf(matched.call, context),
    span: spanOf(declarator, context),
  });
}

// `defineApplication({...});` 写成裸语句时结果被丢弃，没有 declarator 也没有 export default
// 可挂。收下它只为让链接层能报错——不收就是静默：build 绿、starter 全丢、应用不监听（Issue #261）。
// Directive（`"use strict";`）与 ExpressionStatement 共用同一个 AST tag，所以形参要收下两者；
// Directive 的表达式恒为字符串字面量，calledByTailName 自然不会命中。
function lowerDiscardedApplicationDefinition(
  node: Directive | ExpressionStatement,
  topLevel: boolean,
  collector: Collector,
  context: LoweringContext,
): void {
  const matched = calledByTailName(node.expression, "defineApplication", context);
  if (matched === undefined) {
    return;
  }
  collector.applicationDefinitions.push({
    kind: "define-application",
    topLevel,
    discarded: true,
    export: { kind: "none" },
    callee: matched.callee,
    options: defineApplicationOptionsOf(matched.call, context),
    span: spanOf(node, context),
  });
}

function lowerUnsupported(
  node: UnsupportedDeclaration | TSModuleDeclaration,
  declarationKind: UnsupportedNamedDeclarationKind,
  topLevel: boolean,
  mode: ExportMode,
  collector: Collector,
  context: LoweringContext,
): void {
  const name = declarationNameOf(node);
  const generic = typeParameterNamesOf(node).size > 0;
  // 仅非泛型 type-alias 保留右侧（RFC 0012 S2，#274）：schema 追溯要跟"type X = z.infer<typeof s>"
  // 的别名右侧找 typeof；泛型别名追溯不到，按类型生成解码器是合法降级。
  const rhs =
    node.type === "TSTypeAliasDeclaration" && !generic
      ? typeNodeOf(node.typeAnnotation, context)
      : undefined;
  collector.unsupportedDeclarations.push({
    kind: "unsupported-named-declaration",
    declarationKind,
    topLevel,
    name,
    export: declarationExportOf(node.id, mode, context),
    generic,
    ...(rhs === undefined ? {} : { rhs }),
    span: spanOf(node, context),
  });
}

function unsupportedKind(node: UnsupportedDeclaration): UnsupportedNamedDeclarationKind {
  return UNSUPPORTED_DECLARATION_KINDS[node.type];
}

function isUnsupportedDeclaration(node: Node): node is UnsupportedDeclaration {
  // `hasOwn` 而非 `in`：避免与 Object.prototype 同名的节点类型误命中（Issue #114）。
  return Object.hasOwn(UNSUPPORTED_DECLARATION_KINDS, node.type);
}

function visitDefaultDeclaration(
  node: ParserExportDefaultDeclaration,
  topLevel: boolean,
  collector: Collector,
  context: LoweringContext,
): void {
  const mode = { kind: "default-only", owner: node } as const;
  const declaration = node.declaration;
  // `export default defineApplication({...})` 是 ADR 0004（Issue #120）的首选书写形式。默认导出的
  // 调用同时照旧记一条 default-expression export，两份记录各服务一层消费者。
  const matched = calledByTailName(declaration, "defineApplication", context);
  if (matched !== undefined) {
    collector.applicationDefinitions.push({
      kind: "define-application",
      topLevel,
      discarded: false,
      export: declarationExportOf(undefined, mode, context),
      callee: matched.callee,
      options: defineApplicationOptionsOf(matched.call, context),
      span: spanOf(node, context),
    });
    return;
  }
  if (declaration.type === "ClassDeclaration" || declaration.type === "ClassExpression") {
    lowerClass(declaration, topLevel, mode, collector, context);
    return;
  }
  if (declaration.type === "TSInterfaceDeclaration") {
    lowerInterface(declaration, topLevel, mode, collector, context);
    return;
  }
  if (isUnsupportedDeclaration(declaration)) {
    lowerUnsupported(declaration, unsupportedKind(declaration), topLevel, mode, collector, context);
  }
  if (is.Function(declaration)) {
    visitFunctionBody(declaration, collector, context);
  }
}

function visitModuleDeclaration(
  node: ModuleDeclaration,
  topLevel: boolean,
  collector: Collector,
  context: LoweringContext,
): void {
  switch (node.type) {
    case "ImportDeclaration":
      lowerImport(node, collector, context);
      return;
    case "ExportNamedDeclaration":
      if (node.declaration === null) {
        lowerNamedExport(node, collector, context);
        return;
      }
      visitStatement(
        node.declaration,
        topLevel,
        { kind: "named", owner: node },
        collector,
        context,
      );
      return;
    case "ExportAllDeclaration":
      lowerExportAll(node, collector, context);
      return;
    case "ExportDefaultDeclaration":
      lowerDefaultExport(node, collector, context);
      visitDefaultDeclaration(node, topLevel, collector, context);
      return;
    case "TSExportAssignment":
      collector.exports.push({
        kind: "unsupported-export",
        syntaxKind: "export-assignment",
        span: spanOf(node, context),
      });
      return;
    default:
      // Only TSNamespaceExportDeclaration reaches here. `export as namespace X` declares a UMD
      // global and adds no binding to the module graph, so DI analysis has nothing to read from it.
      // Recording an unsupported-export would turn it into a false UNSUPPORTED_MODULE_SYNTAX error
      // on code that compiles today (Issue #22).
      return;
  }
}

function visitStatement(
  node: ProgramStatement,
  topLevel: boolean,
  mode: ExportMode,
  collector: Collector,
  context: LoweringContext,
): void {
  if (is.ModuleDeclaration(node)) {
    visitModuleDeclaration(node, topLevel, collector, context);
    return;
  }
  switch (node.type) {
    case "ClassDeclaration":
      lowerClass(node, topLevel, mode, collector, context);
      return;
    case "TSInterfaceDeclaration":
      lowerInterface(node, topLevel, mode, collector, context);
      return;
    case "TSModuleDeclaration":
      lowerNamespace(node, topLevel, mode, collector, context);
      return;
    case "VariableDeclaration":
      for (const declarator of node.declarations) {
        lowerBeanFactory(node, declarator, topLevel, mode, collector, context);
        lowerApplicationDefinition(declarator, topLevel, mode, collector, context);
        lowerConfigFactoryCall(declarator, topLevel, collector, context);
        lowerValueDeclaration(node, declarator, topLevel, mode, collector, context);
        if (is.Function(declarator.init)) {
          visitFunctionBody(declarator.init, collector, context);
        }
      }
      return;
    case "TSTypeAliasDeclaration":
    case "TSEnumDeclaration":
      lowerUnsupported(node, unsupportedKind(node), topLevel, mode, collector, context);
      return;
    case "FunctionDeclaration":
    case "TSDeclareFunction":
      lowerUnsupported(node, unsupportedKind(node), topLevel, mode, collector, context);
      visitFunctionBody(node, collector, context);
      return;
    case "TSImportEqualsDeclaration":
      // `import Alias = require(...)` is recorded both as an unsupported import and as an
      // unsupported declaration; tests pin this double-write.
      lowerImport(node, collector, context);
      lowerUnsupported(node, unsupportedKind(node), topLevel, mode, collector, context);
      return;
    case "ExpressionStatement":
      lowerDiscardedApplicationDefinition(node, topLevel, collector, context);
      visitNestedStatements(node, collector, context);
      return;
    default:
      visitNestedStatements(node, collector, context);
      return;
  }
}

// 函数体里的声明永远不可能是 provider，但对它保持沉默就复刻了 Issue #54 要根除的静默丢弃：用户在注入点
// 拿到 MISSING_BEAN，而不是在放错位置的声明处拿到 INVALID_DEFINE_BEAN。照非顶层 lower 下来，让分析层去
// 点名真正的错误（Issue #113）。
function visitFunctionBody(
  node: FunctionNode,
  collector: Collector,
  context: LoweringContext,
): void {
  const body = node.body;
  // 重载签名与 `declare function` 没有 body；箭头函数的表达式体里没有声明位置。
  if (body?.type !== "BlockStatement") {
    return;
  }
  for (const statement of body.body) {
    visitStatement(statement, false, { kind: "none" }, collector, context);
  }
}

function visitNestedStatements(
  node: ProgramStatement,
  collector: Collector,
  context: LoweringContext,
): void {
  const visit = (statement: ProgramStatement): void => {
    visitStatement(statement, false, { kind: "none" }, collector, context);
  };
  switch (node.type) {
    case "BlockStatement":
      for (const statement of node.body) {
        visit(statement);
      }
      return;
    case "IfStatement":
      visit(node.consequent);
      if (node.alternate !== null) {
        visit(node.alternate);
      }
      return;
    case "ForStatement":
    case "ForInStatement":
    case "ForOfStatement":
    case "WhileStatement":
    case "DoWhileStatement":
    case "LabeledStatement":
    case "WithStatement":
      visit(node.body);
      return;
    case "SwitchStatement":
      for (const switchCase of node.cases) {
        for (const statement of switchCase.consequent) {
          visit(statement);
        }
      }
      return;
    case "TryStatement":
      visit(node.block);
      if (node.handler !== null) {
        visit(node.handler.body);
      }
      if (node.finalizer !== null) {
        visit(node.finalizer);
      }
      return;
    default:
      return;
  }
}

export function lowerSource(
  file: CanonicalFileId,
  sourceText: string,
  program: Program,
  comments: readonly Comment[],
): SourceFileIr {
  const collector: Collector = {
    imports: [],
    exports: [],
    interfaces: [],
    namespaces: [],
    classes: [],
    beanFactories: [],
    applicationDefinitions: [],
    configFactoryCalls: [],
    valueDeclarations: [],
    unsupportedDeclarations: [],
  };
  const context = { mapper: createSourceMapper(file, sourceText), sourceText };
  for (const statement of program.body) {
    visitStatement(statement, true, { kind: "none" }, collector, context);
  }
  return {
    suppressions: collectSuppressions({ file, sourceText, comments, mapper: context.mapper }),
    imports: normalizeSpanned(collector.imports),
    exports: normalizeSpanned(collector.exports),
    interfaces: normalizeSpanned(collector.interfaces),
    namespaces: normalizeSpanned(collector.namespaces),
    classes: normalizeSpanned(collector.classes),
    beanFactories: normalizeSpanned(collector.beanFactories),
    applicationDefinitions: normalizeSpanned(collector.applicationDefinitions),
    configFactoryCalls: normalizeSpanned(collector.configFactoryCalls),
    valueDeclarations: normalizeSpanned(collector.valueDeclarations),
    unsupportedDeclarations: normalizeSpanned(collector.unsupportedDeclarations),
  };
}
