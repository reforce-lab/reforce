import { describe, expect, test } from "bun:test";
import path from "node:path";
import { isPathContained } from "#internal/project/path-identity";

describe("path containment", () => {
  test("uses native path semantics by default for spaces and Unicode", () => {
    const boundary = path.join(path.parse(process.cwd()).root, "Reforce Projects", "应用");
    const child = path.join(boundary, "source files", "服务.ts");

    const contained = isPathContained(boundary, child);

    expect(contained).toBe(true);
  });

  test("contains Windows children on the same drive", () => {
    const boundary = "C:\\Reforce Projects\\应用";

    const same = isPathContained(boundary, boundary, path.win32);
    const nested = isPathContained(
      boundary,
      "C:\\Reforce Projects\\应用\\source files\\服务.ts",
      path.win32,
    );

    expect(same).toBe(true);
    expect(nested).toBe(true);
  });

  test("rejects Windows sibling, parent traversal, and cross-drive targets", () => {
    const boundary = "C:\\work\\application";

    const sibling = isPathContained(boundary, "C:\\work\\application-copy", path.win32);
    const escaped = isPathContained(boundary, "C:\\work\\application\\..\\outside", path.win32);
    const crossDrive = isPathContained(boundary, "D:\\work\\application\\src", path.win32);

    expect(sibling).toBe(false);
    expect(escaped).toBe(false);
    expect(crossDrive).toBe(false);
  });

  test("contains Windows UNC children on the same share", () => {
    const boundary = "\\\\server\\shared apps\\应用";

    const nested = isPathContained(
      boundary,
      "\\\\server\\shared apps\\应用\\source files\\服务.ts",
      path.win32,
    );

    expect(nested).toBe(true);
  });

  test("rejects UNC parent traversal and targets on another share", () => {
    const boundary = "\\\\server\\shared\\application";

    const escaped = isPathContained(
      boundary,
      "\\\\server\\shared\\application\\..\\outside",
      path.win32,
    );
    const crossShare = isPathContained(
      boundary,
      "\\\\server\\other-share\\application",
      path.win32,
    );
    const crossServer = isPathContained(
      boundary,
      "\\\\other-server\\shared\\application",
      path.win32,
    );

    expect(escaped).toBe(false);
    expect(crossShare).toBe(false);
    expect(crossServer).toBe(false);
  });
});
