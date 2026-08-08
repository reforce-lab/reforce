import { describe, expect, test } from "vitest";
import { checkStarterPackage, findExportsProblem, type StarterPackageProblem } from "@/index";

// 体检回答的是「这个包装到别人的应用里能不能接上」，而不是「这份字节合不合 schema」——后者
// parse 已经管了。这里的每一条都对应一种作者本地零信号、装到别人那儿才炸的失误（#369）。

const packageName = "@acme/starter-redis";

function position(offset: number) {
  return { offset, line: 0, character: offset };
}

function packageJson(overrides: Record<string, unknown> = {}) {
  return {
    name: packageName,
    exports: { ".": "./dist/index.js", "./reforce-meta": "./reforce-meta.json" },
    ...overrides,
  };
}

function meta(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    starterDeps: [],
    symbols: [{ id: `${packageName}#RedisCache`, file: "dist/cache.d.ts", subpaths: ["."] }],
    beans: [
      {
        id: `${packageName}#RedisCache`,
        runtimeExport: { module: packageName, export: "RedisCache" },
        provides: [`${packageName}#RedisCache`],
        dependencies: [],
        source: { file: "src/cache.ts", start: position(0), end: position(1) },
      },
    ],
    ...overrides,
  };
}

const shipped = new Set(["dist/cache.d.ts", "src/cache.ts"]);

function check(
  input: {
    readonly packageJson?: unknown;
    readonly meta?: unknown;
    readonly files?: ReadonlySet<string>;
  } = {},
): readonly StarterPackageProblem[] {
  const files = input.files ?? shipped;
  return checkStarterPackage({
    packageJson: input.packageJson ?? packageJson(),
    meta: input.meta ?? meta(),
    fileExists: (file) => files.has(file),
  });
}

function errorsOf(problems: readonly StarterPackageProblem[]): readonly string[] {
  return problems
    .filter((problem) => problem.severity === "error")
    .map((problem) => problem.message);
}

describe("exports 是唯一的接线口", () => {
  test("直写目标通过", () => {
    expect(findExportsProblem(packageJson())).toBeUndefined();
  });

  test("条件对象的 default 指向目标同样通过", () => {
    const conditional = packageJson({
      exports: { "./reforce-meta": { types: "./x.d.ts", default: "./reforce-meta.json" } },
    });

    expect(findExportsProblem(conditional)).toBeUndefined();
  });

  test("没有 exports 表被点名", () => {
    expect(findExportsProblem({ name: packageName })).toBe(
      "package.json must declare an exports map.",
    );
  });

  test("子路径指向别处被点名", () => {
    const wrong = packageJson({ exports: { "./reforce-meta": "./meta.json" } });

    expect(findExportsProblem(wrong)).toBe(
      'exports must map "./reforce-meta" to "./reforce-meta.json".',
    );
  });

  test("pattern 形态不认：解析结果依赖包管理器语义", () => {
    const pattern = packageJson({ exports: { "./*": "./dist/*.js" } });

    expect(findExportsProblem(pattern)).toBeDefined();
  });
});

describe("包一级的前提", () => {
  test("没有包名时只报这一条：包名是后面每条判定的输入", () => {
    expect(check({ packageJson: { exports: {} } })).toEqual([
      { severity: "error", message: "package.json must declare a name." },
    ]);
  });

  test("字节过不了闸门时不再逐条查 symbols：结构本身不可信", () => {
    const problems = check({ meta: meta({ beans: "not an array" }) });

    expect(problems).toHaveLength(1);
  });

  test("schemaVersion 认不出来时报的是版本，不是一堆字段错", () => {
    const problems = check({ meta: meta({ schemaVersion: 99 }) });

    expect(errorsOf(problems)).toEqual(["schemaVersion 99 is not one this checker knows."]);
  });

  test("requires 里有认不出的能力时硬错", () => {
    const problems = check({ meta: meta({ requires: ["time-travel"] }) });

    expect(errorsOf(problems)).toEqual([
      "requires names capabilities this checker does not know: time-travel.",
    ]);
  });
});

describe("户口表指向的东西必须真的随包发布", () => {
  test("锚点 .d.ts 不在包里是 error：应用侧解析不到这个符号", () => {
    const problems = check({ files: new Set(["src/cache.ts"]) });

    expect(errorsOf(problems)).toEqual([
      `${packageName}#RedisCache is anchored to dist/cache.d.ts, which is not in the package.`,
    ]);
  });

  test("声称的 subpath 不在 exports 里是 error", () => {
    const claiming = meta({
      symbols: [
        { id: `${packageName}#RedisCache`, file: "dist/cache.d.ts", subpaths: ["./testing"] },
      ],
    });

    expect(errorsOf(check({ meta: claiming }))).toEqual([
      `${packageName}#RedisCache claims subpath "./testing", which package.json exports does not declare.`,
    ]);
  });

  test("source 不随包发布只是 warning：接线完好，少的是代码框", () => {
    const problems = check({ files: new Set(["dist/cache.d.ts"]) });

    expect(problems).toEqual([
      {
        severity: "warning",
        message: `${packageName}#RedisCache points at src/cache.ts, which is not in the package; diagnostics about this bean will lose their code frame.`,
      },
    ]);
  });

  test("省略 source 的手写 meta 完全干净", () => {
    const handWritten = meta({
      beans: [
        {
          id: `${packageName}#RedisCache`,
          runtimeExport: { module: packageName, export: "RedisCache" },
          provides: [`${packageName}#RedisCache`],
          dependencies: [],
        },
      ],
    });

    expect(check({ meta: handWritten, files: new Set(["dist/cache.d.ts"]) })).toEqual([]);
  });
});

test("全都对时没有任何问题", () => {
  expect(check()).toEqual([]);
});
