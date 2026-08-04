import { expect, test } from "bun:test";
import { type ParseSourceInput, parseSource } from "@/parser/parse-source";
import type { SourceFileIr, SourceKind } from "@/parser/source-ir";
import type { CanonicalFileId } from "@/parser/source-location";

function canonicalFileId(filename: string): CanonicalFileId {
  return filename as CanonicalFileId; // Production parsing receives this opaque identity from project resolution.
}

function parseFile(sourceText: string, sourceKind: SourceKind = "ts"): SourceFileIr {
  const result = parseSource({
    file: canonicalFileId(`source.${sourceKind}`),
    sourceKind,
    sourceText,
  });
  if (result.status === "failure") {
    throw new Error(JSON.stringify(result.diagnostics));
  }
  return result.unit;
}

test("lowers a directly exported injectable class", () => {
  const input = {
    file: canonicalFileId("src/service.ts"),
    sourceKind: "ts",
    sourceText: "@Injectable() export class Service {}",
  } satisfies ParseSourceInput;

  const result = parseSource(input);

  expect(result.status).toBe("success");
  if (result.status === "failure") {
    throw new Error(JSON.stringify(result.diagnostics));
  }
  expect(result.unit.classes[0]?.name).toBe("Service");
  expect(result.unit.classes[0]?.export.kind).toBe("named");
});

test("classifies supported import and export forms", () => {
  const unit = parseFile(
    [
      'import DefaultValue, * as namespaceValue from "package-a";',
      'import type { Input as LocalInput } from "package-b";',
      "export { DefaultValue as Local };",
      'export { Input as Remote } from "package-c";',
      'export * from "package-d";',
      'export * as tools from "package-e";',
      "export default DefaultValue;",
    ].join("\n"),
  );

  expect(unit.imports.map((declaration) => declaration.kind)).toEqual(["import", "import"]);
  expect(
    unit.imports.flatMap((declaration) =>
      declaration.kind === "import"
        ? declaration.bindings.map((binding) => [
            declaration.moduleSpecifier,
            binding.kind,
            binding.local,
          ])
        : [],
    ),
  ).toEqual([
    ["package-a", "default", "DefaultValue"],
    ["package-a", "namespace", "namespaceValue"],
    ["package-b", "named", "LocalInput"],
  ]);
  expect(unit.exports.map((declaration) => declaration.kind)).toEqual([
    "local-named",
    "reexport-named",
    "reexport-all",
    "namespace",
    "default-local",
  ]);
});

test("lowers interface and namespace declaration structure", () => {
  const unit = parseFile(
    [
      "export interface Port<T> extends Base<T> {}",
      "export namespace Tokens {",
      "  export interface Key {}",
      '  export const label = "token";',
      "}",
    ].join("\n"),
  );

  expect(
    unit.interfaces.map((declaration) => ({
      name: declaration.name,
      topLevel: declaration.topLevel,
      generic: declaration.generic,
      extends: declaration.extends.map((type) => type.kind),
    })),
  ).toEqual([
    { name: "Port", topLevel: true, generic: true, extends: ["reference"] },
    { name: "Key", topLevel: false, generic: false, extends: [] },
  ]);
  expect(
    unit.namespaces.map((declaration) => ({
      name: declaration.name,
      topLevel: declaration.topLevel,
      members: declaration.exportedMembers.map((member) => [member.kind, member.name]),
    })),
  ).toEqual([{ name: "Tokens", topLevel: true, members: [["type", "Key"]] }]);
});

test("lowers standard class decorators and ordinary constructor parameters", () => {
  const unit = parseFile(
    [
      '@Qualifier("primary")',
      "@Primary()",
      "@Injectable()",
      "export class Service<T> implements Port<T> {",
      "  constructor(readonly port: Port<T>, retries: number = 3) {}",
      "  async onContextStart(): Promise<void> {}",
      "}",
    ].join("\n"),
  );
  const declaration = unit.classes[0];

  expect(
    declaration?.decorators.map((decorator) => ({
      callee:
        decorator.callee.kind === "identifier" ? decorator.callee.name : decorator.callee.kind,
      called: decorator.called,
      arguments: decorator.arguments.map((argument) =>
        argument.kind === "string-literal"
          ? [argument.kind, argument.value]
          : [argument.kind, argument.kind === "unsupported" ? argument.expressionKind : undefined],
      ),
    })),
  ).toEqual([
    { callee: "Qualifier", called: true, arguments: [["string-literal", "primary"]] },
    { callee: "Primary", called: true, arguments: [] },
    { callee: "Injectable", called: true, arguments: [] },
  ]);
  expect(
    declaration?.constructors[0]?.parameters.map((parameter) => ({
      type: parameter.type.kind,
      decorators: parameter.decorators.length,
      hasInitializer: parameter.hasInitializer,
    })),
  ).toEqual([
    { type: "reference", decorators: 0, hasInitializer: false },
    { type: "unsupported", decorators: 0, hasInitializer: true },
  ]);
  expect(
    declaration?.methods.map((method) => [method.name.kind, method.async, method.parameterCount]),
  ).toEqual([["identifier", true, 0]]);
});

test("lowers supported defineBean options", () => {
  const unit = parseFile(
    [
      "export const resource = defineBean<Resource>({",
      "  create: () => new Resource(),",
      "  dispose: async (value: Resource) => value.close(),",
      "  primary: true,",
      '  qualifier: "resource",',
      "});",
    ].join("\n"),
  );
  const declaration = unit.beanFactories[0];

  expect(declaration?.name).toBe("resource");
  expect(declaration?.typeArguments.map((type) => type.kind)).toEqual(["reference"]);
  expect(declaration?.options.kind).toBe("object");
  if (declaration?.options.kind !== "object") {
    throw new Error("Expected object-literal defineBean options.");
  }
  expect(
    declaration.options.properties.map((property) => [
      property.kind,
      property.kind === "unsupported-property" ? property.propertyKind : property.value.kind,
    ]),
  ).toEqual([
    ["create", "arrow"],
    ["dispose", "arrow"],
    ["primary", "boolean-literal"],
    ["qualifier", "string-literal"],
  ]);
  expect(
    declaration.options.properties.flatMap((property) => {
      if (
        (property.kind !== "create" && property.kind !== "dispose") ||
        (property.value.kind !== "arrow" && property.value.kind !== "function")
      ) {
        return [];
      }
      return [[property.kind, property.value.parameterCount]];
    }),
  ).toEqual([
    ["create", 0],
    ["dispose", 1],
  ]);
});

test("lowers a defineBean declaration whose callee is parenthesized", () => {
  const unit = parseFile("export const resource = (defineBean)({ create: () => new Resource() });");
  const declaration = unit.beanFactories[0];

  expect(declaration?.name).toBe("resource");
  expect(declaration?.callee).toMatchObject({ kind: "identifier", name: "defineBean" });
});

test("lowers a defineBean declaration whose whole call is parenthesized", () => {
  const unit = parseFile("export const resource = (defineBean({ create: () => new Resource() }));");
  const declaration = unit.beanFactories[0];

  expect(declaration?.name).toBe("resource");
  expect(declaration?.callee).toMatchObject({ kind: "identifier", name: "defineBean" });
});

test("reads parenthesized defineBean options as an object literal", () => {
  const unit = parseFile("export const resource = defineBean(({ qualifier: 'resource' }));");

  expect(unit.beanFactories[0]?.options).toMatchObject({
    kind: "object",
    properties: [{ kind: "qualifier", value: { kind: "string-literal", value: "resource" } }],
  });
});

test("reads a parenthesized defineBean option value as its inner literal", () => {
  const unit = parseFile('export const resource = defineBean({ qualifier: ("resource") });');
  const options = unit.beanFactories[0]?.options;
  if (options?.kind !== "object") {
    throw new Error("Expected object-literal defineBean options.");
  }

  expect(options.properties[0]).toMatchObject({
    kind: "qualifier",
    value: { kind: "string-literal", value: "resource" },
  });
});

test("lowers array constructor parameters with their readonly modifier", () => {
  const unit = parseFile(
    [
      "export class Registry {",
      "  constructor(",
      "    readonly ordered: readonly Handler[],",
      "    readonly mutable: Handler[],",
      "    readonly nested: readonly (readonly Handler[])[],",
      "  ) {}",
      "}",
    ].join("\n"),
  );

  const parameters = unit.classes[0]?.constructors[0]?.parameters ?? [];
  expect(
    parameters.map((parameter) =>
      parameter.type.kind === "array"
        ? {
            kind: parameter.type.kind,
            readonlyModifier: parameter.type.readonlyModifier,
            element: parameter.type.element.kind,
          }
        : { kind: parameter.type.kind },
    ),
  ).toEqual([
    { kind: "array", readonlyModifier: true, element: "reference" },
    { kind: "array", readonlyModifier: false, element: "reference" },
    { kind: "array", readonlyModifier: true, element: "array" },
  ]);
});

test("lowers integer decorator arguments including a unary minus literal", () => {
  const unit = parseFile(
    ["@Order(5) export class First {}", "@Order(-1) export class Second {}"].join("\n"),
  );

  expect(unit.classes.map((declaration) => declaration.decorators[0]?.arguments[0])).toMatchObject([
    { kind: "number-literal", value: 5 },
    { kind: "number-literal", value: -1 },
  ]);
});

test("keeps a computed numeric decorator argument unsupported", () => {
  const unit = parseFile("@Order(1 + 2) export class Service {}");

  expect(unit.classes[0]?.decorators[0]?.arguments).toMatchObject([
    { kind: "unsupported", expressionKind: "binary" },
  ]);
});

test("reads a parenthesized decorator argument as its inner literal", () => {
  const unit = parseFile('@Qualifier(("primary")) export class Service {}');

  expect(unit.classes[0]?.decorators[0]?.arguments).toMatchObject([
    { kind: "string-literal", value: "primary" },
  ]);
});

test("reads a decorator whose whole call is parenthesized", () => {
  const unit = parseFile('@(Qualifier("primary")) export class Service {}');

  expect(unit.classes[0]?.decorators[0]).toMatchObject({
    callee: { kind: "identifier", name: "Qualifier" },
    called: true,
    arguments: [{ kind: "string-literal", value: "primary" }],
  });
});

test("resolves a parenthesized decorator callee to its entity name", () => {
  const unit = parseFile('@(Qualifier)("primary") export class Service {}');

  expect(unit.classes[0]?.decorators[0]?.callee).toMatchObject({
    kind: "identifier",
    name: "Qualifier",
  });
});

test("treats a parenthesized constructor callee as a direct instantiation", () => {
  const unit = parseFile("export const resource = defineBean({ create: () => new (Resource)() });");
  const options = unit.beanFactories[0]?.options;
  if (options?.kind !== "object") {
    throw new Error("Expected object-literal defineBean options.");
  }

  expect(options.properties[0]).toMatchObject({
    kind: "create",
    value: { body: { kind: "direct-new", callee: { kind: "identifier", name: "Resource" } } },
  });
});

test("treats a parenthesized instantiation as a direct instantiation", () => {
  const unit = parseFile("export const resource = defineBean({ create: () => (new Resource()) });");
  const options = unit.beanFactories[0]?.options;
  if (options?.kind !== "object") {
    throw new Error("Expected object-literal defineBean options.");
  }

  expect(options.properties[0]).toMatchObject({
    kind: "create",
    value: { body: { kind: "direct-new", callee: { kind: "identifier", name: "Resource" } } },
  });
});

test("treats a parenthesized create factory as a zero-parameter arrow", () => {
  const unit = parseFile("export const resource = defineBean({ create: (() => new Resource()) });");
  const options = unit.beanFactories[0]?.options;
  if (options?.kind !== "object") {
    throw new Error("Expected object-literal defineBean options.");
  }

  expect(options.properties[0]).toMatchObject({
    kind: "create",
    value: { kind: "arrow", async: false, parameterCount: 0, body: { kind: "direct-new" } },
  });
});

test("keeps a type-asserted constructor callee unsupported", () => {
  // Only parentheses are transparent to lowering. `as` restates what a value is, and that is exactly
  // what provided-type inference reads, so looking through it would change the DI graph. This input
  // fails the moment the unwrapping helper is widened beyond ParenthesizedExpression.
  const unit = parseFile(
    "export const resource = defineBean({ create: () => new (Resource as Base)() });",
  );
  const options = unit.beanFactories[0]?.options;
  if (options?.kind !== "object") {
    throw new Error("Expected object-literal defineBean options.");
  }

  expect(options.properties[0]).toMatchObject({
    kind: "create",
    value: { body: { kind: "unsupported" } },
  });
});

test("exports a parenthesized default identifier as a local binding", () => {
  const unit = parseFile(["class Service {}", "export default (Service);"].join("\n"));

  expect(unit.exports).toMatchObject([{ kind: "default-local", local: "Service" }]);
});

test("lowers ambient declaration signatures without inventing implementations", () => {
  const unit = parseFile(
    [
      "export interface ExternalPort<T> extends Iterable<T> {}",
      "export declare abstract class ExternalBase<T> implements ExternalPort<T> {",
      "  protected constructor(value: T);",
      "  abstract read(): T;",
      "}",
    ].join("\n"),
    "d.ts",
  );
  const declaration = unit.classes[0];

  expect(declaration?.abstract).toBe(true);
  expect(declaration?.generic).toBe(true);
  expect(declaration?.constructors[0]?.accessibility).toBe("protected");
  expect(declaration?.constructors[0]?.implementation).toBe(false);
  expect(declaration?.methods[0]?.implementation).toBe(false);
});

test("reports logical lines while retaining UTF-16 offsets for every line terminator", () => {
  const unit = parseFile(
    "export class A {}\r\nexport class B {}\rexport class C {}\nexport class D {}\u2028export class E {}\u2029export class F {}",
  );

  expect(unit.classes.map((declaration) => declaration.span.start)).toEqual([
    { offset: 7, line: 0, character: 7 },
    { offset: 26, line: 1, character: 7 },
    { offset: 44, line: 2, character: 7 },
    { offset: 62, line: 3, character: 7 },
    { offset: 80, line: 4, character: 7 },
    { offset: 98, line: 5, character: 7 },
  ]);
});

test("counts astral Unicode characters as two UTF-16 code units", () => {
  const unit = parseFile('const marker = "😀";\nexport class Unicode {}');

  expect(unit.classes[0]?.span.start).toEqual({ offset: 28, line: 1, character: 7 });
});

test("pins an anonymous default-exported class span to the class keyword", () => {
  const unit = parseFile("export default class {\n  classify(): void {}\n}");

  expect(unit.classes[0]?.span.start).toEqual({ offset: 15, line: 0, character: 15 });
});

test("pins a decorated anonymous class span to the class keyword", () => {
  const unit = parseFile("export default @Injectable() class {\n  classify(): void {}\n}");

  expect(unit.classes[0]?.span.start).toEqual({ offset: 29, line: 0, character: 29 });
});

test("pins an anonymous class span to the class keyword past an implements clause", () => {
  const unit = parseFile("export default class implements Subclass {\n  run(): void {}\n}");

  expect(unit.classes[0]?.span.start).toEqual({ offset: 15, line: 0, character: 15 });
});

test("classifies unsupported syntax for Compiler diagnostics", () => {
  const unit = parseFile(
    [
      'import Alias = require("package-a");',
      'export type Choice<T> = T extends string ? "yes" : "no";',
      "export enum Direction { Left, Right }",
      "export function helper(): void {}",
      "@decorate(factory()) export class Unsupported {}",
    ].join("\n"),
  );

  expect(unit.imports.map((declaration) => declaration.kind)).toEqual(["unsupported-import"]);
  expect(unit.unsupportedDeclarations.map((declaration) => declaration.declarationKind)).toEqual([
    "import-alias",
    "type-alias",
    "enum",
    "function",
  ]);
  expect(unit.classes[0]?.decorators[0]?.arguments).toMatchObject([
    { kind: "unsupported", expressionKind: "call" },
  ]);
});

// `export default` 是 isUnsupportedDeclaration 谓词的唯一调用点；`export default enum` / `export
// default type` 不是合法 TS，所以这条路径只能到达 function 一类（Issue #114）。
test("records a default-exported function declaration as unsupported", () => {
  const unit = parseFile("export default function helper(): void {}");

  expect(
    unit.unsupportedDeclarations.map((declaration) => [
      declaration.declarationKind,
      declaration.name,
      declaration.export.kind,
    ]),
  ).toEqual([["function", "helper", "default-only"]]);
});

test("records a default-exported ambient function signature as unsupported", () => {
  const unit = parseFile("export default function helper(): void;", "d.ts");

  expect(
    unit.unsupportedDeclarations.map((declaration) => [
      declaration.declarationKind,
      declaration.name,
      declaration.export.kind,
    ]),
  ).toEqual([["function", "helper", "default-only"]]);
});

test("names every kind of declaration a namespace exports", () => {
  const unit = parseFile(
    [
      "export namespace Tokens {",
      "  export function build(): void {}",
      "  export enum Direction { Left }",
      "  export namespace Inner {}",
      "  export type Alias = string;",
      "}",
    ].join("\n"),
  );

  expect(unit.namespaces[0]?.exportedMembers.map((member) => [member.kind, member.name])).toEqual([
    ["value", "build"],
    ["value", "Direction"],
    ["namespace", "Inner"],
    ["type", "Alias"],
  ]);
});

test("lowers a class declared inside a function body as non-top-level", () => {
  const unit = parseFile("function build(): void { @Injectable() class Hidden {} }");

  expect(unit.classes.map((declaration) => [declaration.name, declaration.topLevel])).toEqual([
    ["Hidden", false],
  ]);
});

test("lowers a class declared inside a method body as non-top-level", () => {
  const unit = parseFile(
    ["export class Outer {", "  build(): void { @Injectable() class Inner {} }", "}"].join("\n"),
  );

  expect(unit.classes.map((declaration) => [declaration.name, declaration.topLevel])).toEqual([
    ["Outer", true],
    ["Inner", false],
  ]);
});

test("lowers a defineBean declared inside an arrow function body as non-top-level", () => {
  const unit = parseFile(
    [
      "const build = (): void => {",
      "  const hidden = defineBean<Resource>({ create: () => new Resource() });",
      "};",
    ].join("\n"),
  );

  expect(unit.beanFactories.map((declaration) => [declaration.name, declaration.topLevel])).toEqual(
    [["hidden", false]],
  );
});

test("lowers classes declared in every branch of a try statement as non-top-level", () => {
  const unit = parseFile(
    [
      "try { class Attempted {} }",
      "catch { class Caught {} }",
      "finally { class Finalized {} }",
    ].join("\n"),
  );

  expect(unit.classes.map((declaration) => [declaration.name, declaration.topLevel])).toEqual([
    ["Attempted", false],
    ["Caught", false],
    ["Finalized", false],
  ]);
});

test("keeps an ambient module body out of the lowered unit", () => {
  const unit = parseFile(
    'declare module "untyped-lib" { export class Widget {} export interface Port {} }',
    "d.ts",
  );

  expect({
    classes: unit.classes,
    interfaces: unit.interfaces,
    unsupported: unit.unsupportedDeclarations.map((declaration) => declaration.declarationKind),
  }).toEqual({ classes: [], interfaces: [], unsupported: ["module-augmentation"] });
});

test("lowers declarations inside a dotted namespace as non-top-level", () => {
  const unit = parseFile("export namespace Outer.Inner { export class Service {} }");

  expect(unit.classes.map((declaration) => [declaration.name, declaration.topLevel])).toEqual([
    ["Service", false],
  ]);
});

test("does not record a dotted namespace as a module augmentation", () => {
  const unit = parseFile("export namespace Outer.Inner { export class Service {} }");

  expect(unit.unsupportedDeclarations).toEqual([]);
});

test("lowers a default-exported defineApplication with starter identifiers in order", () => {
  const unit = parseFile("export default defineApplication({ starters: [a, b] });");
  const declaration = unit.applicationDefinitions[0];

  expect(declaration?.export.kind).toBe("default-only");
  expect(declaration?.options).toMatchObject({
    kind: "object",
    properties: [
      {
        kind: "starters",
        value: {
          kind: "array",
          elements: [
            { kind: "identifier", name: "a" },
            { kind: "identifier", name: "b" },
          ],
        },
      },
    ],
  });
});

test("lowers a named defineApplication declaration with an empty starters array", () => {
  const unit = parseFile("export const app = defineApplication({ starters: [] });");
  const declaration = unit.applicationDefinitions[0];

  expect(declaration?.name).toBe("app");
  expect(declaration?.export.kind).toBe("named");
  expect(declaration?.options).toMatchObject({
    kind: "object",
    properties: [{ kind: "starters", value: { kind: "array", elements: [] } }],
  });
});

test("keeps a non-array starters value unsupported", () => {
  const unit = parseFile("export default defineApplication({ starters: list });");
  const options = unit.applicationDefinitions[0]?.options;
  if (options?.kind !== "object") {
    throw new Error("Expected object-literal defineApplication options.");
  }

  expect(options.properties[0]).toMatchObject({
    kind: "starters",
    value: { kind: "unsupported", expressionKind: "identifier" },
  });
});

test("records an unknown defineApplication option key as an unsupported property", () => {
  const unit = parseFile('export default defineApplication({ starters: [], mode: "x" });');
  const options = unit.applicationDefinitions[0]?.options;
  if (options?.kind !== "object") {
    throw new Error("Expected object-literal defineApplication options.");
  }

  expect(options.properties[1]).toMatchObject({
    kind: "unsupported-property",
    propertyKind: "unknown-key",
  });
});

test("records a spread starters element as an unsupported element", () => {
  const unit = parseFile("export default defineApplication({ starters: [...list] });");
  const options = unit.applicationDefinitions[0]?.options;
  if (options?.kind !== "object") {
    throw new Error("Expected object-literal defineApplication options.");
  }

  expect(options.properties[0]).toMatchObject({
    kind: "starters",
    value: {
      kind: "array",
      elements: [{ kind: "unsupported-element", expressionKind: "other" }],
    },
  });
});

test("records nothing for a default-exported call to another function", () => {
  const unit = parseFile("export default defineApp({ starters: [a] });");

  expect(unit.applicationDefinitions).toEqual([]);
});

test("lowers a defineApplication declared inside a function body as non-top-level", () => {
  const unit = parseFile(
    ["function build(): void {", "  const app = defineApplication({ starters: [a] });", "}"].join(
      "\n",
    ),
  );

  expect(
    unit.applicationDefinitions.map((declaration) => [declaration.name, declaration.topLevel]),
  ).toEqual([["app", false]]);
});

test("rejects a source file when syntax is incomplete", () => {
  const input = {
    file: canonicalFileId("src/broken.ts"),
    sourceKind: "ts",
    sourceText: "export class {",
  } satisfies ParseSourceInput;

  const result = parseSource(input);

  expect(result.status).toBe("failure");
  if (result.status === "success") {
    throw new Error("Expected invalid syntax to fail parsing.");
  }
  expect(result.diagnostics.map((item) => item.code)).toEqual(["PARSER_SYNTAX_ERROR"]);
});
