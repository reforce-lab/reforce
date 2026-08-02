import { expect, test } from "bun:test";
import type { CanonicalFileId, SourceSpan } from "@reforce/compiler-spi";
import fc from "fast-check";
import { diagnostic, orderDiagnostics } from "./diagnostics";

function sourceSpan(fileId: string): SourceSpan {
  return {
    fileId: fileId as CanonicalFileId, // These fixed relative test paths satisfy the canonical file ID grammar.
    start: { offset: 1, line: 0, character: 1 },
    end: { offset: 2, line: 0, character: 2 },
  };
}

const records = [
  diagnostic({
    code: "TYPE_LINK_FAILED",
    message: "zeta",
    related: [{ message: "z" }, { message: "a" }, { message: "a" }],
  }),
  diagnostic({ code: "TYPE_LINK_FAILED", message: "alpha" }),
  diagnostic({ code: "TYPE_LINK_FAILED", message: "alpha" }),
];

test("diagnostic ordering and exact dedupe are independent of insertion order", () => {
  fc.assert(
    fc.property(
      fc.shuffledSubarray(records, { minLength: records.length, maxLength: records.length }),
      (shuffled) => {
        expect(orderDiagnostics(shuffled)).toEqual(orderDiagnostics(records));
      },
    ),
  );
});

test("related information uses full-record ordering and exact dedupe", () => {
  // Arrange
  const item = diagnostic({
    code: "TYPE_LINK_FAILED",
    message: "failure",
    related: [
      { message: "a message that must not outrank its span", sourceSpan: sourceSpan("z.ts") },
      { message: "z message", sourceSpan: sourceSpan("a.ts") },
      { message: "z message", sourceSpan: sourceSpan("a.ts") },
    ],
  });

  // Act
  const related = item.related;

  // Assert
  expect(related.map((entry) => String(entry.sourceSpan?.fileId))).toEqual(["a.ts", "z.ts"]);
});
