import { expect, test } from "bun:test";
import {
  type PortableSourceIdentity,
  registerPortableSourceIdentity,
} from "#internal/project/source-identity";

test("reports case-only source identities backed by different physical files", () => {
  // Arrange
  const identities = new Map<string, PortableSourceIdentity>();
  const first = { realpath: "/project/src/Service.ts", id: "src/Service.ts" };
  registerPortableSourceIdentity(identities, first);

  // Act
  const collision = registerPortableSourceIdentity(identities, {
    realpath: "/project/src/service.ts",
    id: "src/service.ts",
  });

  // Assert
  expect(collision).toEqual(first);
});

test("accepts portable source identities that differ beyond letter case", () => {
  // Arrange
  const identities = new Map<string, PortableSourceIdentity>();
  registerPortableSourceIdentity(identities, {
    realpath: "/project/src/Service.ts",
    id: "src/Service.ts",
  });

  // Act
  const collision = registerPortableSourceIdentity(identities, {
    realpath: "/project/src/ServiceFactory.ts",
    id: "src/ServiceFactory.ts",
  });

  // Assert
  expect(collision).toBeUndefined();
});
