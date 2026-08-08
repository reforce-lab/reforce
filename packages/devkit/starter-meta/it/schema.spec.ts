import { readFileSync } from "node:fs";
import { isRelativePosixPath } from "@reforce/primitives";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  metaShapes,
  parseContractCoordinate,
  starterMetaCapabilities,
  supportedSchemaVersions,
} from "@/index";

// schema.json 是**手写**的，parser 是准入的唯一真相——两者天然是双事实源（#369）。这份守卫
// 就是不让它们漂：键名逐层对着 metaShapes 核，版本与能力词汇表对着 parser 的常量核，坐标与
// 路径的 pattern 对着 parser 的判定对拍。
//
// 只核「parser 收 ⇒ schema 收」这个方向：schema 的定位是编辑器补全用的宽松近似（跨字段约束
// 表达不了），比 parser 松是设计，比 parser 严则会让一份完全合法的 meta 在编辑器里飘红。

const schema: unknown = JSON.parse(
  readFileSync(new URL("../schema.json", import.meta.url), "utf8"),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectAt(root: unknown, path: readonly string[]): Record<string, unknown> {
  let current = root;
  for (const segment of path) {
    if (!isRecord(current)) {
      throw new Error(`schema.json has no object at ${path.join("/")}`);
    }
    current = current[segment];
  }
  if (!isRecord(current)) {
    throw new Error(`schema.json has no object at ${path.join("/")}`);
  }
  return current;
}

function stringsAt(root: unknown, path: readonly string[], key: string): readonly string[] {
  const value = objectAt(root, path)[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`schema.json ${path.join("/")}.${key} is not a string array`);
  }
  return value;
}

// root 是文档本身，其余每层各占一个 $defs 条目——名字与 metaShapes 的键一一对应，正是靠这条
// 对应关系才能逐层核键名。
function pathOfShape(name: string): readonly string[] {
  return name === "root" ? [] : ["$defs", name];
}

function patternAt(name: string): RegExp {
  const pattern = objectAt(schema, ["$defs", name]).pattern;
  if (typeof pattern !== "string") {
    throw new Error(`schema.json $defs/${name} has no string pattern`);
  }
  return new RegExp(pattern, "u");
}

const shapes = Object.entries(metaShapes);

describe("schema.json 的键名不与 parser 漂", () => {
  test.each(shapes)("%s 层认得的键正是 metaShapes 说的那些", (name, shape) => {
    const node = objectAt(schema, pathOfShape(name));

    expect(Object.keys(objectAt(node, ["properties"])).toSorted()).toEqual(
      [...shape.required, ...shape.optional].toSorted(),
    );
  });

  test.each(shapes)("%s 层的必填键正是 metaShapes 说的那些", (name, shape) => {
    expect(stringsAt(schema, pathOfShape(name), "required").toSorted()).toEqual(
      [...shape.required].toSorted(),
    );
  });

  test.each(shapes)("%s 层放行未知键：那是消费侧的兼容规则", (name) => {
    // schema 比 parser 严的话，一份新版 meta 会在老编辑器里整片飘红，而读者其实照常接受它。
    expect(objectAt(schema, pathOfShape(name)).additionalProperties).toBe(true);
  });
});

describe("版本与能力词汇表来自 parser", () => {
  test("schemaVersion 枚举就是 supportedSchemaVersions", () => {
    expect(objectAt(schema, ["properties", "schemaVersion"]).enum).toEqual([
      ...supportedSchemaVersions,
    ]);
  });

  test("requires 的词汇表就是 starterMetaCapabilities", () => {
    expect(objectAt(schema, ["properties", "requires", "items"]).enum).toEqual([
      ...starterMetaCapabilities,
    ]);
  });
});

describe("coordinate pattern 与 parser 对拍", () => {
  const accepted = [
    "@acme/starter-redis#Cache",
    "acme#Cache",
    "@acme/x:dist/a.d.ts#Cache",
    "acme:dist/a.d.ts#Cache",
  ];
  const rejected = [
    "@acme/x",
    "#Cache",
    "@acme/x#",
    "@acme/x#a#b",
    "./local#Cache",
    "/abs#Cache",
    "@acme#Cache",
    "acme/extra#Cache",
    "acme\\x#Cache",
  ];

  test.each(accepted)("parser 收 %s，pattern 也收", (value) => {
    expect(parseContractCoordinate(value)).toBeDefined();
    expect(patternAt("coordinate").test(value)).toBe(true);
  });

  test.each(rejected)("parser 拒 %s，pattern 也拒", (value) => {
    expect(parseContractCoordinate(value)).toBeUndefined();
    expect(patternAt("coordinate").test(value)).toBe(false);
  });
});

describe("relativePath pattern 不比 isRelativePosixPath 严", () => {
  test("parser 收的路径 pattern 一律收", () => {
    const pattern = patternAt("relativePath");

    fc.assert(
      fc.property(fc.string(), (value) => !isRelativePosixPath(value) || pattern.test(value)),
    );
  });

  test.each(["src/cache.ts", "dist/a.d.ts", ".hidden/x", "a.b.c"])("%s 两侧都收", (value) => {
    expect(isRelativePosixPath(value)).toBe(true);
    expect(patternAt("relativePath").test(value)).toBe(true);
  });

  test.each(["/abs.ts", "../up.ts", "a/./b", "a//b", "C:/x.ts", "a\\b"])("%s 两侧都拒", (value) => {
    expect(isRelativePosixPath(value)).toBe(false);
    expect(patternAt("relativePath").test(value)).toBe(false);
  });
});
