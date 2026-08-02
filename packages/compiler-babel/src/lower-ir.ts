import type {
  CanonicalFileId,
  ClassDeclaration,
  ClassMethodDeclaration,
  ClassMethodName,
  ConstructorDeclaration,
  DeclarationExport,
  DefineBeanDeclaration,
  DefineBeanOptionProperty,
  DefineBeanOptions,
  ExportDeclaration,
  ExportSpecifier,
  FrontendSourceKind,
  ImportBinding,
  ImportDeclaration,
  InterfaceDeclaration,
  NamespaceDeclaration,
  NamespaceExportedMember,
  NamespaceMemberKind,
  SourceUnit,
  UnsupportedNamedDeclaration,
  UnsupportedNamedDeclarationKind,
} from "@reforce/compiler-spi";
import {
  type AstNode,
  booleanProperty,
  isAstNode,
  nodeArrayProperty,
  nodeProperty,
  stringProperty,
} from "#internal/ast";
import {
  constructorParametersOf,
  decoratorsOf,
  entityNameOf,
  expressionKindOf,
  expressionValueOf,
  functionDescriptorOf,
  functionParametersOf,
  identifierOf,
  type LoweringContext,
  sourceKeywordSpan,
  spanOf,
  typeNodeOf,
  typeParameterNamesOf,
  typeParametersOf,
} from "#internal/lower-values";
import { normalizeSpanned } from "#internal/normalize";
import { createSourceMapper } from "#internal/source-map";

type ExportMode =
  | { readonly kind: "none" }
  | { readonly kind: "named"; readonly owner: AstNode }
  | { readonly kind: "default-only"; readonly owner: AstNode };

interface Collector {
  readonly imports: ImportDeclaration[];
  readonly exports: ExportDeclaration[];
  readonly interfaces: InterfaceDeclaration[];
  readonly namespaces: NamespaceDeclaration[];
  readonly classes: ClassDeclaration[];
  readonly beanFactories: DefineBeanDeclaration[];
  readonly unsupportedDeclarations: UnsupportedNamedDeclaration[];
}

function createCollector(): Collector {
  return {
    imports: [],
    exports: [],
    interfaces: [],
    namespaces: [],
    classes: [],
    beanFactories: [],
    unsupportedDeclarations: [],
  };
}

function declarationExportOf(
  node: AstNode,
  mode: ExportMode,
  context: LoweringContext,
): DeclarationExport {
  if (mode.kind === "none") {
    return { kind: "none" };
  }
  if (mode.kind === "default-only") {
    return { kind: "default-only", span: spanOf(mode.owner, context) };
  }
  const name = identifierOf(nodeProperty(node, "id"), context);
  if (name === undefined) {
    return { kind: "none" };
  }
  return { kind: "named", exportedName: name, span: spanOf(mode.owner, context) };
}

function moduleSpecifierOf(node: AstNode | undefined, context: LoweringContext) {
  if (node === undefined || typeof node.value !== "string") {
    return undefined;
  }
  return { text: node.value, span: spanOf(node, context) };
}

function importBindingOf(
  specifier: AstNode,
  declarationTypeOnly: boolean,
  context: LoweringContext,
): ImportBinding | undefined {
  const local = identifierOf(nodeProperty(specifier, "local"), context);
  if (local === undefined) {
    return undefined;
  }
  const typeOnly = declarationTypeOnly || stringProperty(specifier, "importKind") === "type";
  if (specifier.type === "ImportDefaultSpecifier") {
    return { kind: "default", local, typeOnly, span: spanOf(specifier, context) };
  }
  if (specifier.type === "ImportNamespaceSpecifier") {
    return { kind: "namespace", local, typeOnly, span: spanOf(specifier, context) };
  }
  if (specifier.type !== "ImportSpecifier") {
    return undefined;
  }
  const importedNode = nodeProperty(specifier, "imported");
  const imported =
    identifierOf(importedNode, context) ??
    (importedNode && typeof importedNode.value === "string"
      ? { text: importedNode.value, span: spanOf(importedNode, context) }
      : undefined);
  return imported === undefined
    ? undefined
    : { kind: "named", imported, local, typeOnly, span: spanOf(specifier, context) };
}

function lowerImport(node: AstNode, collector: Collector, context: LoweringContext): void {
  if (node.type === "TSImportEqualsDeclaration") {
    collector.imports.push({
      kind: "unsupported-import",
      syntaxKind: "import-equals",
      span: spanOf(node, context),
    });
    return;
  }
  if (node.type !== "ImportDeclaration") {
    return;
  }
  if (hasImportAttributes(node)) {
    collector.imports.push({
      kind: "unsupported-import",
      syntaxKind: "attributes",
      span: spanOf(node, context),
    });
    return;
  }
  const moduleSpecifier = moduleSpecifierOf(nodeProperty(node, "source"), context);
  if (moduleSpecifier === undefined) {
    collector.imports.push({
      kind: "unsupported-import",
      syntaxKind: "other",
      span: spanOf(node, context),
    });
    return;
  }
  const typeOnly = stringProperty(node, "importKind") === "type";
  collector.imports.push({
    kind: "import",
    moduleSpecifier,
    typeOnly,
    bindings: normalizeSpanned(
      nodeArrayProperty(node, "specifiers").flatMap((specifier) => {
        const binding = importBindingOf(specifier, typeOnly, context);
        return binding === undefined ? [] : [binding];
      }),
    ),
    span: spanOf(node, context),
  });
}

function hasImportAttributes(node: AstNode): boolean {
  const attributes = node.attributes;
  const assertions = node.assertions;
  return (
    (Array.isArray(attributes) && attributes.length > 0) ||
    (Array.isArray(assertions) && assertions.length > 0)
  );
}

function exportedIdentifier(node: AstNode | undefined, context: LoweringContext) {
  return (
    identifierOf(node, context) ??
    (node && typeof node.value === "string"
      ? { text: node.value, span: spanOf(node, context) }
      : undefined)
  );
}

function exportSpecifierOf(
  node: AstNode,
  declarationTypeOnly: boolean,
  context: LoweringContext,
): ExportSpecifier | undefined {
  if (node.type !== "ExportSpecifier") {
    return undefined;
  }
  const local = exportedIdentifier(nodeProperty(node, "local"), context);
  const exported = exportedIdentifier(nodeProperty(node, "exported"), context);
  if (local === undefined || exported === undefined) {
    return undefined;
  }
  return {
    local,
    exported,
    typeOnly: declarationTypeOnly || stringProperty(node, "exportKind") === "type",
    span: spanOf(node, context),
  };
}

function lowerNamedExport(node: AstNode, collector: Collector, context: LoweringContext): void {
  if (hasImportAttributes(node)) {
    collector.exports.push({
      kind: "unsupported-export",
      syntaxKind: "attributes",
      span: spanOf(node, context),
    });
    return;
  }
  const typeOnly = stringProperty(node, "exportKind") === "type";
  const source = moduleSpecifierOf(nodeProperty(node, "source"), context);
  const namespace = nodeArrayProperty(node, "specifiers").find(
    (specifier) => specifier.type === "ExportNamespaceSpecifier",
  );
  if (source !== undefined && namespace !== undefined) {
    const exported = exportedIdentifier(nodeProperty(namespace, "exported"), context);
    if (exported !== undefined) {
      collector.exports.push({
        kind: "namespace",
        moduleSpecifier: source,
        exported,
        typeOnly,
        span: spanOf(node, context),
      });
      return;
    }
  }
  const specifiers = nodeArrayProperty(node, "specifiers").flatMap((specifier) => {
    const lowered = exportSpecifierOf(specifier, typeOnly, context);
    return lowered === undefined ? [] : [lowered];
  });
  if (source === undefined) {
    collector.exports.push({
      kind: "local-named",
      typeOnly,
      specifiers,
      span: spanOf(node, context),
    });
    return;
  }
  collector.exports.push({
    kind: "reexport-named",
    moduleSpecifier: source,
    typeOnly,
    specifiers,
    span: spanOf(node, context),
  });
}

function lowerExport(node: AstNode, collector: Collector, context: LoweringContext): void {
  if (node.type === "ExportNamedDeclaration") {
    if (nodeProperty(node, "declaration") === undefined) {
      lowerNamedExport(node, collector, context);
    }
    return;
  }
  if (node.type === "ExportAllDeclaration") {
    lowerExportAll(node, collector, context);
    return;
  }
  if (node.type === "ExportDefaultDeclaration") {
    const declaration = nodeProperty(node, "declaration");
    const local = identifierOf(declaration, context);
    collector.exports.push(
      local === undefined
        ? {
            kind: "default-expression",
            expressionKind: declaration ? expressionKindOf(declaration) : "other",
            span: spanOf(node, context),
          }
        : { kind: "default-local", local, span: spanOf(node, context) },
    );
    return;
  }
  if (node.type === "TSExportAssignment") {
    collector.exports.push({
      kind: "unsupported-export",
      syntaxKind: "export-assignment",
      span: spanOf(node, context),
    });
  }
}

function lowerExportAll(node: AstNode, collector: Collector, context: LoweringContext): void {
  const source = moduleSpecifierOf(nodeProperty(node, "source"), context);
  if (source === undefined) {
    return;
  }
  const exported = exportedIdentifier(nodeProperty(node, "exported"), context);
  collector.exports.push(
    exported === undefined
      ? {
          kind: "reexport-all",
          moduleSpecifier: source,
          typeOnly: stringProperty(node, "exportKind") === "type",
          span: spanOf(node, context),
        }
      : {
          kind: "namespace",
          moduleSpecifier: source,
          exported,
          typeOnly: stringProperty(node, "exportKind") === "type",
          span: spanOf(node, context),
        },
  );
}

function classMethodNameOf(method: AstNode, context: LoweringContext): ClassMethodName {
  const key = nodeProperty(method, "key");
  if (key === undefined || booleanProperty(method, "computed")) {
    return { kind: "computed", span: spanOf(key ?? method, context) };
  }
  const identifier = identifierOf(key, context);
  if (identifier !== undefined) {
    return { kind: "identifier", name: identifier };
  }
  if (typeof key.value === "string") {
    return { kind: "string-literal", value: key.value, span: spanOf(key, context) };
  }
  return { kind: "computed", span: spanOf(key, context) };
}

function accessibilityOf(node: AstNode): "public" | "protected" | "private" {
  const accessibility = stringProperty(node, "accessibility");
  return accessibility === "protected" || accessibility === "private" ? accessibility : "public";
}

function classMethodOf(
  method: AstNode,
  context: LoweringContext,
  classTypeParameters: ReadonlySet<string>,
): ClassMethodDeclaration | undefined {
  if (stringProperty(method, "kind") !== "method") {
    return undefined;
  }
  const value = nodeProperty(method, "value") ?? method;
  if (value === undefined) {
    return undefined;
  }
  const methodTypeParameters = new Set([...classTypeParameters, ...typeParameterNamesOf(value)]);
  const returnAnnotation = nodeProperty(value, "returnType") ?? nodeProperty(method, "returnType");
  const returnType = returnAnnotation
    ? (nodeProperty(returnAnnotation, "typeAnnotation") ?? returnAnnotation)
    : undefined;
  return {
    kind: "method",
    name: classMethodNameOf(method, context),
    static: booleanProperty(method, "static"),
    accessibility: accessibilityOf(method),
    async: booleanProperty(value, "async"),
    generator: booleanProperty(value, "generator"),
    optional: booleanProperty(method, "optional") || booleanProperty(value, "optional"),
    implementation: nodeProperty(value, "body")?.type === "BlockStatement",
    parameters: functionParametersOf(value, context, methodTypeParameters),
    ...(returnType === undefined
      ? {}
      : { returnType: typeNodeOf(returnType, context, methodTypeParameters) }),
    span: spanOf(method, context),
  };
}

function constructorOf(
  method: AstNode,
  context: LoweringContext,
  typeParameters: ReadonlySet<string>,
): ConstructorDeclaration | undefined {
  if (stringProperty(method, "kind") !== "constructor") {
    return undefined;
  }
  const value = nodeProperty(method, "value") ?? method;
  if (value === undefined) {
    return undefined;
  }
  return {
    kind: "constructor",
    accessibility: accessibilityOf(method),
    implementation: nodeProperty(value, "body")?.type === "BlockStatement",
    parameters: constructorParametersOf(value, context, typeParameters),
    span: spanOf(method, context),
  };
}

function lowerClass(
  node: AstNode,
  topLevel: boolean,
  mode: ExportMode,
  collector: Collector,
  context: LoweringContext,
): void {
  const typeParameters = typeParameterNamesOf(node);
  const body = nodeProperty(node, "body");
  const members = body === undefined ? [] : nodeArrayProperty(body, "body");
  collector.classes.push({
    kind: "class",
    topLevel,
    abstract: booleanProperty(node, "abstract"),
    ...(identifierOf(nodeProperty(node, "id"), context) === undefined
      ? {}
      : { name: identifierOf(nodeProperty(node, "id"), context) }),
    export: declarationExportOf(node, mode, context),
    typeParameters: typeParametersOf(node, context),
    decorators: decoratorsOf(node, context),
    implements: normalizeSpanned(
      nodeArrayProperty(node, "implements").map((implemented) =>
        typeNodeOf(implemented, context, typeParameters),
      ),
    ),
    constructors: normalizeSpanned(
      members.flatMap((member) => {
        const declaration = constructorOf(member, context, typeParameters);
        return declaration === undefined ? [] : [declaration];
      }),
    ),
    methods: normalizeSpanned(
      members.flatMap((member) => {
        const method = classMethodOf(member, context, typeParameters);
        return method === undefined ? [] : [method];
      }),
    ),
    span: sourceKeywordSpan(node, "class", context),
  });
}

function lowerInterface(
  node: AstNode,
  topLevel: boolean,
  mode: ExportMode,
  collector: Collector,
  context: LoweringContext,
): void {
  const typeParameters = typeParameterNamesOf(node);
  collector.interfaces.push({
    kind: "interface",
    topLevel,
    ...(identifierOf(nodeProperty(node, "id"), context) === undefined
      ? {}
      : { name: identifierOf(nodeProperty(node, "id"), context) }),
    export: declarationExportOf(node, mode, context),
    typeParameters: typeParametersOf(node, context),
    extends: normalizeSpanned(
      nodeArrayProperty(node, "extends").map((extended) =>
        typeNodeOf(extended, context, typeParameters),
      ),
    ),
    span: sourceKeywordSpan(node, "interface", context),
  });
}

function namespaceMemberKind(node: AstNode): NamespaceMemberKind {
  if (
    node.type === "TSInterfaceDeclaration" ||
    node.type === "TSTypeAliasDeclaration" ||
    stringProperty(node, "importKind") === "type"
  ) {
    return "type";
  }
  return node.type === "TSModuleDeclaration" ? "namespace" : "value";
}

function namespaceMembersOf(
  node: AstNode,
  context: LoweringContext,
): readonly NamespaceExportedMember[] {
  const body = nodeProperty(node, "body");
  const statements = body?.type === "TSModuleBlock" ? nodeArrayProperty(body, "body") : [];
  return normalizeSpanned(
    statements.flatMap((statement) => {
      if (statement.type !== "ExportNamedDeclaration") {
        return [];
      }
      const declaration = nodeProperty(statement, "declaration");
      if (declaration !== undefined) {
        const name = identifierOf(nodeProperty(declaration, "id"), context);
        return name === undefined
          ? []
          : [{ kind: namespaceMemberKind(declaration), name, span: spanOf(statement, context) }];
      }
      return nodeArrayProperty(statement, "specifiers").flatMap((specifier) => {
        const name = exportedIdentifier(nodeProperty(specifier, "exported"), context);
        return name === undefined
          ? []
          : [{ kind: "value", name, span: spanOf(specifier, context) }];
      });
    }),
  );
}

function lowerNamespace(
  node: AstNode,
  topLevel: boolean,
  mode: ExportMode,
  collector: Collector,
  context: LoweringContext,
): void {
  const name = identifierOf(nodeProperty(node, "id"), context);
  if (name === undefined) {
    lowerUnsupported(node, "module-augmentation", topLevel, mode, collector, context);
    return;
  }
  collector.namespaces.push({
    kind: "namespace",
    topLevel,
    name,
    export: declarationExportOf(node, mode, context),
    exportedMembers: namespaceMembersOf(node, context),
    span: sourceKeywordSpan(node, "namespace", context),
  });
  const body = nodeProperty(node, "body");
  if (body?.type === "TSModuleBlock") {
    for (const statement of nodeArrayProperty(body, "body")) {
      visitStatement(statement, false, { kind: "none" }, collector, context);
    }
  } else if (body?.type === "TSModuleDeclaration") {
    lowerNamespace(body, false, { kind: "none" }, collector, context);
  }
}

function defineBeanOptionsOf(node: AstNode, context: LoweringContext): DefineBeanOptions {
  if (node.type !== "ObjectExpression") {
    return {
      kind: "unsupported",
      expressionKind: expressionKindOf(node),
      span: spanOf(node, context),
    };
  }
  return {
    kind: "object",
    properties: nodeArrayProperty(node, "properties").map((property) =>
      defineBeanOptionOf(property, context),
    ),
    span: spanOf(node, context),
  };
}

function defineBeanOptionOf(property: AstNode, context: LoweringContext): DefineBeanOptionProperty {
  if (property.type === "SpreadElement" || property.type === "SpreadProperty") {
    return {
      kind: "unsupported-property",
      propertyKind: "spread",
      span: spanOf(property, context),
    };
  }
  if (booleanProperty(property, "computed")) {
    return {
      kind: "unsupported-property",
      propertyKind: "computed",
      span: spanOf(property, context),
    };
  }
  if (property.type === "ObjectMethod" || booleanProperty(property, "method")) {
    return {
      kind: "unsupported-property",
      propertyKind: "method",
      span: spanOf(property, context),
    };
  }
  const key = nodeProperty(property, "key");
  const value = nodeProperty(property, "value");
  const keyName =
    identifierOf(key, context)?.text ?? (typeof key?.value === "string" ? key.value : undefined);
  if (key === undefined || value === undefined || !isDefineBeanKey(keyName)) {
    return {
      kind: "unsupported-property",
      propertyKind: "unknown-key",
      span: spanOf(property, context),
    };
  }
  const keySpan = spanOf(key, context);
  if (keyName === "create" || keyName === "dispose") {
    return {
      kind: keyName,
      keySpan,
      value: functionDescriptorOf(value, context) ?? expressionValueOf(value, context),
      span: spanOf(property, context),
    };
  }
  return {
    kind: keyName,
    keySpan,
    value: expressionValueOf(value, context),
    span: spanOf(property, context),
  };
}

function isDefineBeanKey(
  value: string | undefined,
): value is "create" | "dispose" | "primary" | "qualifier" {
  return value === "create" || value === "dispose" || value === "primary" || value === "qualifier";
}

function entityTail(entity: ReturnType<typeof entityNameOf>): string | undefined {
  if (entity === undefined) {
    return undefined;
  }
  return entity.kind === "identifier" ? entity.name.text : entity.right.text;
}

function lowerBeanFactory(
  declaration: AstNode,
  declarator: AstNode,
  topLevel: boolean,
  mode: ExportMode,
  collector: Collector,
  context: LoweringContext,
): void {
  const call = nodeProperty(declarator, "init");
  if (call?.type !== "CallExpression" && call?.type !== "OptionalCallExpression") {
    return;
  }
  const callee = entityNameOf(nodeProperty(call, "callee"), context);
  if (callee === undefined || entityTail(callee) !== "defineBean") {
    return;
  }
  const options = nodeArrayProperty(call, "arguments")[0];
  collector.beanFactories.push({
    kind: "define-bean",
    topLevel,
    declarationKind: variableDeclarationKind(declaration),
    ...(identifierOf(nodeProperty(declarator, "id"), context) === undefined
      ? {}
      : { name: identifierOf(nodeProperty(declarator, "id"), context) }),
    export: declarationExportOf(declarator, mode, context),
    callee,
    typeArguments: callTypeArguments(call).map((argument) => typeNodeOf(argument, context)),
    options:
      options === undefined
        ? { kind: "unsupported", expressionKind: "other", span: spanOf(call, context) }
        : defineBeanOptionsOf(options, context),
    span: spanOf(declarator, context),
  });
}

function variableDeclarationKind(node: AstNode): "const" | "let" | "var" {
  const kind = stringProperty(node, "kind");
  return kind === "let" || kind === "var" ? kind : "const";
}

function callTypeArguments(node: AstNode): readonly AstNode[] {
  const owner = nodeProperty(node, "typeArguments") ?? nodeProperty(node, "typeParameters");
  return owner === undefined ? [] : nodeArrayProperty(owner, "params");
}

function lowerUnsupported(
  node: AstNode,
  declarationKind: UnsupportedNamedDeclarationKind,
  topLevel: boolean,
  mode: ExportMode,
  collector: Collector,
  context: LoweringContext,
): void {
  collector.unsupportedDeclarations.push({
    kind: "unsupported-named-declaration",
    declarationKind,
    topLevel,
    ...(identifierOf(nodeProperty(node, "id"), context) === undefined
      ? {}
      : { name: identifierOf(nodeProperty(node, "id"), context) }),
    export: declarationExportOf(node, mode, context),
    typeParameters: typeParametersOf(node, context),
    span: spanOf(node, context),
  });
}

function unsupportedKind(node: AstNode): UnsupportedNamedDeclarationKind | undefined {
  const kinds: Readonly<Record<string, UnsupportedNamedDeclarationKind>> = {
    TSTypeAliasDeclaration: "type-alias",
    TSEnumDeclaration: "enum",
    FunctionDeclaration: "function",
    TSDeclareFunction: "function",
    TSImportEqualsDeclaration: "import-alias",
  };
  return kinds[node.type];
}

function visitWrappedExport(
  node: AstNode,
  topLevel: boolean,
  collector: Collector,
  context: LoweringContext,
): boolean {
  if (node.type !== "ExportNamedDeclaration" && node.type !== "ExportDefaultDeclaration") {
    return false;
  }
  const declaration = nodeProperty(node, "declaration");
  if (declaration === undefined) {
    return false;
  }
  visitStatement(
    declaration,
    topLevel,
    { kind: node.type === "ExportNamedDeclaration" ? "named" : "default-only", owner: node },
    collector,
    context,
  );
  return true;
}

function visitStatement(
  node: AstNode,
  topLevel: boolean,
  mode: ExportMode,
  collector: Collector,
  context: LoweringContext,
): void {
  lowerImport(node, collector, context);
  lowerExport(node, collector, context);
  if (visitWrappedExport(node, topLevel, collector, context)) {
    return;
  }
  if (node.type === "ClassDeclaration") {
    lowerClass(node, topLevel, mode, collector, context);
    return;
  }
  if (node.type === "TSInterfaceDeclaration") {
    lowerInterface(node, topLevel, mode, collector, context);
    return;
  }
  if (node.type === "TSModuleDeclaration") {
    lowerNamespace(node, topLevel, mode, collector, context);
    return;
  }
  if (node.type === "VariableDeclaration") {
    for (const declarator of nodeArrayProperty(node, "declarations")) {
      lowerBeanFactory(node, declarator, topLevel, mode, collector, context);
    }
    return;
  }
  const kind = unsupportedKind(node);
  if (kind !== undefined) {
    lowerUnsupported(node, kind, topLevel, mode, collector, context);
    return;
  }
  visitNestedStatements(node, collector, context);
}

function visitNestedStatements(
  node: AstNode,
  collector: Collector,
  context: LoweringContext,
): void {
  const statementKeys = ["body", "consequent", "alternate"];
  for (const key of statementKeys) {
    const value = node[key];
    if (isAstNode(value)) {
      visitStatement(value, false, { kind: "none" }, collector, context);
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isAstNode(item)) {
          visitStatement(item, false, { kind: "none" }, collector, context);
        }
      }
    }
  }
}

export function lowerSourceUnit(
  file: CanonicalFileId,
  sourceKind: FrontendSourceKind,
  sourceText: string,
  program: unknown,
): SourceUnit {
  if (!isAstNode(program) || program.type !== "Program") {
    throw new TypeError("Parser did not return a Program node.");
  }
  const collector = createCollector();
  const context = { mapper: createSourceMapper(file, sourceText), sourceText };
  for (const statement of nodeArrayProperty(program, "body")) {
    visitStatement(statement, true, { kind: "none" }, collector, context);
  }
  return {
    kind: "source-unit",
    file,
    sourceKind,
    imports: normalizeSpanned(collector.imports),
    exports: normalizeSpanned(collector.exports),
    interfaces: normalizeSpanned(collector.interfaces),
    namespaces: normalizeSpanned(collector.namespaces),
    classes: normalizeSpanned(collector.classes),
    beanFactories: normalizeSpanned(collector.beanFactories),
    unsupportedDeclarations: normalizeSpanned(collector.unsupportedDeclarations),
  };
}
