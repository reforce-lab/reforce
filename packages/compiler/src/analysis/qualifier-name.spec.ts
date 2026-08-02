import { expect, test } from "bun:test";
import { validQualifierName } from "#internal/analysis/qualifier-name";

test("rejects identifiers reserved in strict TypeScript modules", () => {
  // Arrange
  const names = [
    "enum",
    "await",
    "implements",
    "interface",
    "package",
    "private",
    "protected",
    "public",
    "static",
  ];

  // Act
  const results = names.map((name) => validQualifierName(name));

  // Assert
  expect(results).toEqual(names.map(() => false));
});

test("accepts contextual TypeScript keywords that are valid declaration names", () => {
  // Arrange
  const names = ["async", "from", "get", "of", "set", "type"];

  // Act
  const results = names.map((name) => validQualifierName(name));

  // Assert
  expect(results).toEqual(names.map(() => true));
});
