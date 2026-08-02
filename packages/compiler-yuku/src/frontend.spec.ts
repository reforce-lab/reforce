import { expect, test } from "bun:test";
import type { CanonicalFileId, FrontendInput } from "@reforce/compiler-spi";
import { yukuFrontend } from "#internal/frontend";

function canonicalFileId(filename: string): CanonicalFileId {
  return filename as CanonicalFileId; // The adapter receives this opaque identity from Compiler in production.
}

test("lowers a directly exported injectable class", async () => {
  const input = {
    file: canonicalFileId("src/service.ts"),
    sourceKind: "ts",
    sourceText: "@Injectable() export class Service {}",
  } satisfies FrontendInput;

  const result = await yukuFrontend.parse(input);

  expect(result.diagnostics).toEqual([]);
  expect(result.unit?.classes[0]?.name?.text).toBe("Service");
  expect(result.unit?.classes[0]?.export.kind).toBe("named");
});

test("rejects a source unit when syntax is incomplete", async () => {
  const input = {
    file: canonicalFileId("src/broken.ts"),
    sourceKind: "ts",
    sourceText: "export class {",
  } satisfies FrontendInput;

  const result = await yukuFrontend.parse(input);

  expect(result.unit).toBeUndefined();
  expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["PARSER_SYNTAX_ERROR"]);
});
