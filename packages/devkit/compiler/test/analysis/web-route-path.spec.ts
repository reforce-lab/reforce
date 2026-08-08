import { describe, expect, test } from "vitest";
import { sourceReference } from "@/analysis/model";
import type { HttpMethodModel } from "@/analysis/web-model";
import {
  normalizedPrefix,
  type RouteCandidate,
  reportRouteConflicts,
  routeDecoratorNames,
  routeMethodByDecorator,
  routePathOf,
  validRouteHandlerMethod,
} from "@/analysis/web-route-path";
import type { CompilerDiagnostic } from "@/api";
import type { ClassMethodDeclaration } from "@/parser/source-ir";
import { singleFileIr, span } from "./support/ir";

// 路径词表与冲突检测此前只有 it/ 层的 51 例护栏（要起真编译器、写临时项目树），这些纯函数
// 分支没有任何确定性回归（#363）。它们不依赖 linker，直接喂 IR 就能测。

const anchor = span("src/controller.ts");

function collect(): CompilerDiagnostic[] {
  return [];
}

function codes(diagnostics: readonly CompilerDiagnostic[]): readonly string[] {
  return diagnostics.map((item) => item.code);
}

function handlerMethod(overrides: Partial<ClassMethodDeclaration> = {}): ClassMethodDeclaration {
  return {
    kind: "method",
    name: { kind: "identifier", name: "show", span: anchor },
    static: false,
    accessibility: "public",
    async: false,
    generator: false,
    optional: false,
    implementation: true,
    parameters: [],
    decorators: [],
    span: anchor,
    ...overrides,
  };
}

const controllerFile = singleFileIr("src/controller.ts", "/project/src/controller.ts");

function candidate(
  method: HttpMethodModel,
  path: string,
  shapeKey: string,
  offset: number,
  handler = "show",
): RouteCandidate {
  const at = span("src/controller.ts", offset);
  return {
    route: {
      method,
      path,
      controller: { source: controllerFile.source, exportName: "GreetingController" },
      controllerId: "src/controller.ts#GreetingController",
      handler,
      middleware: [],
      meta: new Map(),
      contract: { slots: [], response: { kind: "passthrough" } },
      throws: [],
      source: sourceReference(at),
    },
    shapeKey,
    span: at,
    fileId: "src/controller.ts",
  };
}

describe("normalizedPrefix", () => {
  test("normalizes the two empty spellings to the same prefix", () => {
    const diagnostics = collect();

    const results = [
      normalizedPrefix("", anchor, diagnostics),
      normalizedPrefix("/", anchor, diagnostics),
    ];

    expect(results).toEqual(["", ""]);
  });

  test("drops one trailing slash so joining never doubles it", () => {
    const diagnostics = collect();

    const result = normalizedPrefix("/greetings/", anchor, diagnostics);

    expect(result).toBe("/greetings");
  });

  test("rejects a prefix that does not start with a slash", () => {
    const diagnostics = collect();

    const result = normalizedPrefix("greetings", anchor, diagnostics);

    expect(result).toBeUndefined();
    expect(codes(diagnostics)).toEqual(["INVALID_ROUTE_DECLARATION"]);
  });
});

describe("routePathOf", () => {
  test("joins an empty base and an empty sub path into the root path", () => {
    const diagnostics = collect();

    const result = routePathOf("", "", anchor, diagnostics);

    expect(result).toEqual({ path: "/", shapeKey: "", parameters: new Set() });
  });

  test("normalizes parameter segments away in the conflict shape key", () => {
    const diagnostics = collect();

    const result = routePathOf("/greetings", "/:name", anchor, diagnostics);

    expect(result).toMatchObject({ path: "/greetings/:name", shapeKey: "greetings/:" });
  });

  test("gives two routes whose parameters differ only by name the same shape key", () => {
    const diagnostics = collect();

    const left = routePathOf("/greetings", "/:name", anchor, diagnostics);
    const right = routePathOf("/greetings", "/:id", anchor, diagnostics);

    expect(left?.shapeKey).toBe(right?.shapeKey);
  });

  test("collects the declared parameter names", () => {
    const diagnostics = collect();

    const result = routePathOf("/a/:one", "/b/:two", anchor, diagnostics);

    expect(result?.parameters).toEqual(new Set(["one", "two"]));
  });

  test("rejects a parameter whose name is not an identifier", () => {
    const diagnostics = collect();

    const result = routePathOf("", "/:1st", anchor, diagnostics);

    expect(result).toBeUndefined();
    expect(codes(diagnostics)).toEqual(["INVALID_ROUTE_DECLARATION"]);
  });

  test("rejects the same parameter name declared twice on one path", () => {
    const diagnostics = collect();

    const result = routePathOf("/:name", "/:name", anchor, diagnostics);

    expect(result).toBeUndefined();
    expect(codes(diagnostics)).toEqual(["INVALID_ROUTE_DECLARATION"]);
  });

  test("rejects an empty segment produced by a doubled slash", () => {
    const diagnostics = collect();

    const result = routePathOf("/greetings", "//show", anchor, diagnostics);

    expect(result).toBeUndefined();
    expect(codes(diagnostics)).toEqual(["INVALID_ROUTE_DECLARATION"]);
  });

  test.each([
    ["greet.v1", true],
    ["greet_v1", true],
    ["greet~v1", true],
    ["greet-v1", true],
    ["greet v1", false],
    ["greet+v1", false],
    ["greet*", false],
    ["greet%20", false],
  ])("decides whether the static segment %s is supported", (segment, supported) => {
    const diagnostics = collect();

    const result = routePathOf("", `/${segment}`, anchor, diagnostics);

    expect(result !== undefined).toBe(supported);
  });
});

describe("validRouteHandlerMethod", () => {
  test("accepts a public instance method implementation with an identifier name", () => {
    const diagnostics = collect();

    const result = validRouteHandlerMethod(handlerMethod(), "GreetingController", diagnostics);

    expect(result).toBe("show");
    expect(diagnostics).toEqual([]);
  });

  test.each([
    ["static", { static: true }],
    ["non-public", { accessibility: "private" as const }],
    ["generator", { generator: true }],
    ["optional", { optional: true }],
    ["overload signature", { implementation: false }],
    ["computed name", { name: { kind: "computed" as const, span: anchor } }],
  ])("rejects a %s handler", (_label, overrides) => {
    const diagnostics = collect();

    const result = validRouteHandlerMethod(
      handlerMethod(overrides),
      "GreetingController",
      diagnostics,
    );

    expect(result).toBeUndefined();
    expect(codes(diagnostics)).toEqual(["INVALID_ROUTE_DECLARATION"]);
  });
});

describe("reportRouteConflicts", () => {
  test("keeps the first registration and reports the later one", () => {
    const diagnostics = collect();

    const unique = reportRouteConflicts(
      [
        candidate("GET", "/greetings/:id", "greetings/:", 20, "byId"),
        candidate("GET", "/greetings/:name", "greetings/:", 10, "byName"),
      ],
      diagnostics,
    );

    expect(unique.map((route) => route.handler)).toEqual(["byName"]);
    expect(codes(diagnostics)).toEqual(["DUPLICATE_ROUTE"]);
  });

  test("points the conflict at the earlier registration through related information", () => {
    const diagnostics = collect();

    reportRouteConflicts(
      [
        candidate("GET", "/greetings/:id", "greetings/:", 20, "byId"),
        candidate("GET", "/greetings/:name", "greetings/:", 10, "byName"),
      ],
      diagnostics,
    );

    expect(diagnostics[0]?.related[0]?.message).toBe("src/controller.ts#GreetingController#byName");
  });

  test("does not treat the same path under different methods as a conflict", () => {
    const diagnostics = collect();

    const unique = reportRouteConflicts(
      [
        candidate("GET", "/greetings", "greetings", 10),
        candidate("POST", "/greetings", "greetings", 20, "create"),
      ],
      diagnostics,
    );

    expect(unique).toHaveLength(2);
    expect(diagnostics).toEqual([]);
  });
});

describe("route decorator table", () => {
  // routeDecoratorNames 是 routeMethodByDecorator 键集的派生，两者必须同文件同步——加了一个
  // HTTP 方法却没跟上装饰器名单，方法级装饰器落位裁决会把它当"不能标方法的装饰器"硬错。
  test("derives the decorator name set from the method table", () => {
    expect([...routeDecoratorNames].toSorted()).toEqual(
      Object.keys(routeMethodByDecorator).toSorted(),
    );
  });
});
