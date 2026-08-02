import { expect, test } from "bun:test";
import { type ParseSourceInput, parseSource } from "./parse-source";
import type { SourceKind, SourceUnit } from "./source-ir";
import type { CanonicalFileId } from "./source-location";

function canonicalFileId(filename: string): CanonicalFileId {
  return filename as CanonicalFileId; // The adapter receives this opaque identity from Compiler in production.
}

function parseUnit(sourceText: string, sourceKind: SourceKind = "ts"): SourceUnit {
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
  expect(result.unit.classes[0]?.name?.text).toBe("Service");
  expect(result.unit.classes[0]?.export.kind).toBe("named");
});

test("classifies supported import and export forms", () => {
  const unit = parseUnit(
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
            declaration.moduleSpecifier.text,
            binding.kind,
            binding.local.text,
            binding.typeOnly,
          ])
        : [],
    ),
  ).toEqual([
    ["package-a", "default", "DefaultValue", false],
    ["package-a", "namespace", "namespaceValue", false],
    ["package-b", "named", "LocalInput", true],
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
  const unit = parseUnit(
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
      name: declaration.name?.text,
      topLevel: declaration.topLevel,
      typeParameters: declaration.typeParameters.map((parameter) => parameter.name.text),
      extends: declaration.extends.map((type) => type.kind),
    })),
  ).toEqual([
    { name: "Port", topLevel: true, typeParameters: ["T"], extends: ["reference"] },
    { name: "Key", topLevel: false, typeParameters: [], extends: [] },
  ]);
  expect(
    unit.namespaces.map((declaration) => ({
      name: declaration.name.text,
      topLevel: declaration.topLevel,
      members: declaration.exportedMembers.map((member) => [member.kind, member.name.text]),
    })),
  ).toEqual([{ name: "Tokens", topLevel: true, members: [["type", "Key"]] }]);
});

test("lowers standard class decorators and ordinary constructor parameters", () => {
  const unit = parseUnit(
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
        decorator.callee.kind === "identifier" ? decorator.callee.name.text : decorator.callee.kind,
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
    { type: "primitive", decorators: 0, hasInitializer: true },
  ]);
  expect(declaration?.methods.map((method) => [method.name.kind, method.async])).toEqual([
    ["identifier", true],
  ]);
});

test("lowers supported defineBean options", () => {
  const unit = parseUnit(
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

  expect(declaration?.name?.text).toBe("resource");
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
});

test("lowers ambient declaration signatures without inventing implementations", () => {
  const unit = parseUnit(
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

  expect(unit.sourceKind).toBe("d.ts");
  expect(declaration?.abstract).toBe(true);
  expect(declaration?.constructors[0]?.accessibility).toBe("protected");
  expect(declaration?.constructors[0]?.implementation).toBe(false);
  expect(declaration?.methods[0]?.implementation).toBe(false);
});

test("reports logical lines while retaining UTF-16 offsets for every line terminator", () => {
  const unit = parseUnit(
    "export class A {}\r\nexport class B {}\rexport class C {}\nexport class D {}\u2028export class E {}\u2029export class F {}",
  );

  expect(unit.classes.map((declaration) => declaration.name?.span.start)).toEqual([
    { offset: 13, line: 0, character: 13 },
    { offset: 32, line: 1, character: 13 },
    { offset: 50, line: 2, character: 13 },
    { offset: 68, line: 3, character: 13 },
    { offset: 86, line: 4, character: 13 },
    { offset: 104, line: 5, character: 13 },
  ]);
});

test("counts astral Unicode characters as two UTF-16 code units", () => {
  const unit = parseUnit('const marker = "😀";\nexport class Unicode {}');

  expect(unit.classes[0]?.name?.span.start).toEqual({ offset: 34, line: 1, character: 13 });
});

test("classifies unsupported syntax for Compiler diagnostics", () => {
  const unit = parseUnit(
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

test("rejects a source unit when syntax is incomplete", () => {
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
