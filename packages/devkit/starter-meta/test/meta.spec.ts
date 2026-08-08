import { describe, expect, test } from "vitest";
import {
  parseContractCoordinate,
  parseStarterMeta,
  type StarterMetaParseResult,
  starterMetaCapabilities,
  supportedSchemaVersions,
} from "@/index";

// meta 的准入此前只有编译器 IT 覆盖（要起真编译器、写临时项目树），parser 本身零单测。
// 它现在是公开契约（#369），兼容规则必须逐条钉住——那是外部 starter 作者唯一能依赖的东西。

const packageName = "@acme/starter-redis";

function position(offset: number) {
  return { offset, line: 0, character: offset };
}

function bean(overrides: Record<string, unknown> = {}) {
  return {
    id: `${packageName}#RedisCache`,
    runtimeExport: { module: packageName, export: "RedisCache" },
    provides: [`${packageName}#RedisCache`],
    dependencies: [],
    source: { file: "src/cache.ts", start: position(0), end: position(1) },
    ...overrides,
  };
}

function meta(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    starterDeps: [],
    symbols: [{ id: `${packageName}#RedisCache`, file: "dist/cache.d.ts", subpaths: ["."] }],
    beans: [bean()],
    ...overrides,
  };
}

function parse(value: unknown, options?: { readonly strict?: boolean }): StarterMetaParseResult {
  return parseStarterMeta(value, packageName, options);
}

function expectSuccess(result: StarterMetaParseResult) {
  if (result.status !== "success") {
    throw new Error(`expected success, got ${JSON.stringify(result)}`);
  }
  return result.meta;
}

describe("坐标文法", () => {
  test("包名#导出名解析成 meta 形态", () => {
    expect(parseContractCoordinate("@acme/starter-redis#Cache")).toEqual({
      kind: "meta",
      packageName: "@acme/starter-redis",
      exportName: "Cache",
    });
  });

  test("包名:包内路径#导出名解析成 file 形态", () => {
    expect(parseContractCoordinate("@acme/x:dist/a.d.ts#Cache")).toEqual({
      kind: "file",
      packageName: "@acme/x",
      file: "dist/a.d.ts",
      exportName: "Cache",
    });
  });

  test.each([
    ["没有 #", "@acme/x"],
    ["# 在开头", "#Cache"],
    ["# 在结尾", "@acme/x#"],
    ["两个 #", "@acme/x#a#b"],
    ["相对路径当包名", "./local#Cache"],
    ["绝对路径当包名", "/abs#Cache"],
    ["scope 少一段", "@acme#Cache"],
    ["非 scope 多一段", "acme/extra#Cache"],
    ["反斜杠", "acme\\x#Cache"],
  ])("拒绝 %s", (_label, value) => {
    expect(parseContractCoordinate(value)).toBeUndefined();
  });
});

describe("schemaVersion 是 major 硬门", () => {
  test("认得的 major 通过", () => {
    expect(parse(meta()).status).toBe("success");
  });

  test.each([0, 2, 99])("不认得的 major %p 报 unsupported-version 而不是 invalid", (version) => {
    const result = parse(meta({ schemaVersion: version }));

    expect(result).toEqual({ status: "unsupported-version", foundVersion: String(version) });
  });

  test("非数字的 schemaVersion 同样落 unsupported-version", () => {
    expect(parse(meta({ schemaVersion: "1" })).status).toBe("unsupported-version");
  });

  test("支持的 major 表是数组而不是区间：历史 major 的 parser 并列存在", () => {
    expect([...supportedSchemaVersions]).toEqual([1]);
  });
});

describe("未知键一律忽略", () => {
  // 不这么做的话，每加一个键都要升 major、全网 starter 同时失效。
  test("顶层未知键不影响解析", () => {
    expect(parse(meta({ futureTopLevel: { anything: true } })).status).toBe("success");
  });

  test("bean 上的未知键不影响解析", () => {
    expect(parse(meta({ beans: [bean({ futureBeanKey: 1 })] })).status).toBe("success");
  });

  test("dependency 上的未知键不影响解析", () => {
    const withDependency = bean({
      dependencies: [{ contract: `${packageName}#Port`, open: false, futureEdgeKey: "x" }],
    });

    expect(parse(meta({ beans: [withDependency] })).status).toBe("success");
  });

  test("symbol、runtimeExport 与 source 上的未知键同样忽略", () => {
    const value = meta({
      symbols: [
        { id: `${packageName}#RedisCache`, file: "dist/cache.d.ts", subpaths: ["."], future: 1 },
      ],
      beans: [
        bean({
          runtimeExport: { module: packageName, export: "RedisCache", future: 1 },
          source: { file: "src/cache.ts", start: position(0), end: position(1), future: 1 },
        }),
      ],
    });

    expect(parse(value).status).toBe("success");
  });

  test("strict 下未知键当场判非法：自产 round-trip 自检要抓的正是这个", () => {
    const result = parse(meta({ futureTopLevel: 1 }), { strict: true });

    expect(result.status).toBe("invalid");
  });

  test("必填键缺失在两种模式下都非法", () => {
    const withoutBeans = { schemaVersion: 1, starterDeps: [], symbols: [] };

    expect(parse(withoutBeans).status).toBe("invalid");
    expect(parse(withoutBeans, { strict: true }).status).toBe("invalid");
  });
});

describe("requires 能力门", () => {
  test("认得的能力照常通过并留在解析结果里", () => {
    const parsed = expectSuccess(parse(meta({ requires: ["collection"] })));

    expect(parsed.requires).toEqual(["collection"]);
  });

  test("不认得的能力硬错，而不是忽略后错配", () => {
    const result = parse(meta({ requires: ["collection", "time-travel"] }));

    expect(result).toEqual({ status: "unsupported-capability", required: ["time-travel"] });
  });

  test("能力门排在其余校验之前：读者不认识能力时，后面的解析结果本身不可信", () => {
    const broken = meta({ requires: ["time-travel"], starterDeps: ["not a package name!"] });

    expect(parse(broken).status).toBe("unsupported-capability");
  });

  test("缺省 requires 等价于空表", () => {
    expect(expectSuccess(parse(meta())).requires).toEqual([]);
  });

  test("requires 必须是字符串数组", () => {
    expect(parse(meta({ requires: [1] })).status).toBe("invalid");
  });

  test("首批词汇表只有 collection", () => {
    // 判据是「读者忽略这个键会不会导致错误的接线而不是响亮的报错」。collection 缺席等于单边，
    // 静默错配；defaultBean 缺席只会让 bean 以普通候选参与裁决、撞车时 AMBIGUOUS_BEAN。
    expect([...starterMetaCapabilities]).toEqual(["collection"]);
  });
});

describe("跨字段约束", () => {
  test("provides 必须含 bean 自己的坐标", () => {
    const result = parse(meta({ beans: [bean({ provides: [`${packageName}#Other`] })] }));

    expect(result).toMatchObject({ status: "invalid" });
  });

  test("runtimeExport.module 必须留在本包内", () => {
    const outside = bean({ runtimeExport: { module: "@other/pkg", export: "X" } });

    expect(parse(meta({ beans: [outside] })).status).toBe("invalid");
  });

  test("bean id 必须是本包的 meta 坐标", () => {
    expect(parse(meta({ beans: [bean({ id: "@other/pkg#X" })] })).status).toBe("invalid");
  });

  test("重复的 bean id 被点名", () => {
    expect(parse(meta({ beans: [bean(), bean()] })).status).toBe("invalid");
  });

  test("source 的 end 不能早于 start", () => {
    const reversed = bean({ source: { file: "src/a.ts", start: position(5), end: position(1) } });

    expect(parse(meta({ beans: [reversed] })).status).toBe("invalid");
  });

  test("symbol file 必须是包内相对 posix 路径", () => {
    const absolute = meta({
      symbols: [{ id: `${packageName}#RedisCache`, file: "/abs/cache.d.ts", subpaths: ["."] }],
    });

    expect(parse(absolute).status).toBe("invalid");
  });
});

describe("可选键的缺省语义", () => {
  test("collection 缺席等于单边——正是它要登记进 requires 的原因", () => {
    const parsed = expectSuccess(
      parse(
        meta({
          beans: [bean({ dependencies: [{ contract: `${packageName}#Port`, open: false }] })],
        }),
      ),
    );

    expect(parsed.beans[0]?.dependencies[0]?.collection).toBe(false);
  });

  test("lifecycle 缺席等于两个钩子都没有", () => {
    expect(expectSuccess(parse(meta())).beans[0]?.lifecycle).toEqual({
      start: false,
      close: false,
    });
  });

  test("role 缺席等于 demand", () => {
    expect(expectSuccess(parse(meta())).beans[0]?.role).toBe("demand");
  });

  test("defaultBean 缺席等于 false", () => {
    expect(expectSuccess(parse(meta())).beans[0]?.defaultBean).toBe(false);
  });

  test("source 可以整个省掉：手写 meta 最易错的就是这个字段", () => {
    const { source: _source, ...withoutSource } = bean();

    expect(expectSuccess(parse(meta({ beans: [withoutSource] }))).beans[0]?.source).toBeUndefined();
  });

  test("写了 source 就得写对：省略与写错是两回事", () => {
    const broken = bean({
      source: { file: "../outside.ts", start: position(0), end: position(1) },
    });

    expect(parse(meta({ beans: [broken] })).status).toBe("invalid");
  });
});
