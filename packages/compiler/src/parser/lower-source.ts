import { type AliasMap, is, nameOf } from "yuku-ast";
import type {
  BaseNode,
  Class,
  Declaration,
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
  decoratorsOf,
  entityNameOf,
  expressionKindOf,
  expressionValueOf,
  functionDescriptorOf,
  identifierTextOf,
  type LoweringContext,
  sourceKeywordSpan,
  spanOf,
  typeNodeOf,
  typeParameterNamesOf,
  unparenthesized,
} from "@/parser/lower-values";
import { normalizeSpanned } from "@/parser/normalize";
import type {
  ClassDeclaration,
  ClassMethodDeclaration,
  ClassMethodName,
  ConstructorDeclaration,
  DeclarationExport,
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
  UnsupportedNamedDeclaration,
  UnsupportedNamedDeclarationKind,
} from "@/parser/source-ir";
import type { CanonicalFileId } from "@/parser/source-location";
import { createSourceMapper } from "@/parser/source-location";

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
  readonly unsupportedDeclarations: UnsupportedNamedDeclaration[];
}

// 别名组由 parser 的 AST 定义生成，parser 新增方法节点类型时这里自动跟随；手写成员列表会漂移
// （Issue #91）。同理，模块声明的判定用 `is.ModuleDeclaration` 而非手写 type 列表。
type ClassMethod = AliasMap["Method"];
type FunctionNode = AliasMap["Function"];
type UnsupportedDeclaration = NodeOfType<
  | "FunctionDeclaration"
  | "TSDeclareFunction"
  | "TSEnumDeclaration"
  | "TSImportEqualsDeclaration"
  | "TSTypeAliasDeclaration"
>;

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
    parameterCount: value.params.length,
    ...(returnType === undefined
      ? {}
      : { returnType: typeNodeOf(returnType, context, methodTypeParameters) }),
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

function lowerClass(
  node: Class,
  topLevel: boolean,
  mode: ExportMode,
  collector: Collector,
  context: LoweringContext,
): void {
  const typeParameters = typeParameterNamesOf(node);
  const methods = node.body.body.filter(is.Method);
  const name = identifierTextOf(node.id);
  collector.classes.push({
    kind: "class",
    topLevel,
    abstract: node.abstract ?? false,
    ...(name === undefined ? {} : { name }),
    export: declarationExportOf(node.id, mode, context),
    generic: typeParameters.size > 0,
    decorators: decoratorsOf(node.decorators, context),
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
  switch (declaration.type) {
    case "ClassDeclaration":
    case "FunctionDeclaration":
    case "TSDeclareFunction":
    case "TSEnumDeclaration":
    case "TSImportEqualsDeclaration":
    case "TSInterfaceDeclaration":
    case "TSTypeAliasDeclaration":
    case "TSModuleDeclaration":
      return identifierTextOf(declaration.id);
    default:
      return undefined;
  }
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
): value is "create" | "dispose" | "primary" | "qualifier" {
  return value === "create" || value === "dispose" || value === "primary" || value === "qualifier";
}

function entityTail(entity: EntityName | undefined): string | undefined {
  if (entity === undefined) {
    return undefined;
  }
  return entity.kind === "identifier" ? entity.name : entity.right;
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
  const call = unparenthesized(init);
  if (call.type !== "CallExpression") {
    return;
  }
  const callee = entityNameOf(call.callee, context);
  if (callee === undefined || entityTail(callee) !== "defineBean") {
    return;
  }
  const options = call.arguments[0];
  const name = identifierTextOf(declarator.id);
  collector.beanFactories.push({
    kind: "define-bean",
    topLevel,
    declarationKind: variableDeclarationKind(declaration),
    ...(name === undefined ? {} : { name }),
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

function lowerUnsupported(
  node: UnsupportedDeclaration | TSModuleDeclaration,
  declarationKind: UnsupportedNamedDeclarationKind,
  topLevel: boolean,
  mode: ExportMode,
  collector: Collector,
  context: LoweringContext,
): void {
  const name = declarationNameOf(node);
  collector.unsupportedDeclarations.push({
    kind: "unsupported-named-declaration",
    declarationKind,
    topLevel,
    ...(name === undefined ? {} : { name }),
    export: declarationExportOf(node.id, mode, context),
    generic: typeParameterNamesOf(node).size > 0,
    span: spanOf(node, context),
  });
}

function unsupportedKind(node: UnsupportedDeclaration): UnsupportedNamedDeclarationKind {
  switch (node.type) {
    case "TSTypeAliasDeclaration":
      return "type-alias";
    case "TSEnumDeclaration":
      return "enum";
    case "FunctionDeclaration":
    case "TSDeclareFunction":
      return "function";
    case "TSImportEqualsDeclaration":
      return "import-alias";
  }
}

function isUnsupportedDeclaration(node: Node): node is UnsupportedDeclaration {
  return (
    node.type === "TSTypeAliasDeclaration" ||
    node.type === "TSEnumDeclaration" ||
    node.type === "FunctionDeclaration" ||
    node.type === "TSDeclareFunction" ||
    node.type === "TSImportEqualsDeclaration"
  );
}

function visitDefaultDeclaration(
  node: ParserExportDefaultDeclaration,
  topLevel: boolean,
  collector: Collector,
  context: LoweringContext,
): void {
  const mode = { kind: "default-only", owner: node } as const;
  const declaration = node.declaration;
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
): SourceFileIr {
  const collector: Collector = {
    imports: [],
    exports: [],
    interfaces: [],
    namespaces: [],
    classes: [],
    beanFactories: [],
    unsupportedDeclarations: [],
  };
  const context = { mapper: createSourceMapper(file, sourceText), sourceText };
  for (const statement of program.body) {
    visitStatement(statement, true, { kind: "none" }, collector, context);
  }
  return {
    imports: normalizeSpanned(collector.imports),
    exports: normalizeSpanned(collector.exports),
    interfaces: normalizeSpanned(collector.interfaces),
    namespaces: normalizeSpanned(collector.namespaces),
    classes: normalizeSpanned(collector.classes),
    beanFactories: normalizeSpanned(collector.beanFactories),
    unsupportedDeclarations: normalizeSpanned(collector.unsupportedDeclarations),
  };
}
