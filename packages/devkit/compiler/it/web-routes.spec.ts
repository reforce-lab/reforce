import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  bundleEntry,
  createTemporaryProject,
  type ProjectTree,
  resolveNodeExecutable,
  runCommand,
  type TemporaryProject,
} from "@reforce/tooling-testing";
import { afterAll, describe, expect, test } from "vitest";
import { type CompileResult, createCompiler, type GeneratedFile } from "@/index";
import {
  type CompileSuccess,
  linkApplicationPackages,
  linkLoggingPackage,
  linkWebPackage,
} from "./support/project";
import {
  nodeModulesTree,
  starterHandleDeclaration,
  starterHandleRuntime,
  starterMetaSpan,
  starterPackage,
} from "./support/starters";

// web 核心 IT（ADR 0006 W1/W3/W4/W5，#142 / #152）：路由表是编译器的第二种生成物——
// routes.json 稳定序列化可 diff，routes.ts 是 typed-edge 背书的可执行表。这里钉住：
// 表内容与两次编译逐字节一致、同路径同方法硬错、链压平三级决胜（阶段 → order → beanId）、
// marker 提取边界、旧 schemas 实参的迁移硬错(RFC 0012 S2,#274)，以及"假适配器消费路由表 +
// 请求作用域 + 洋葱 + 槽位解码 + 编码白名单 + 错误处理器兜底"的完整链路（真实引擎适配是
// #153；槽位形态与硬错的系统覆盖在 it/web-slots.spec.ts）。

type FailureResult = Extract<CompileResult, { readonly status: "failure" }>;

const nodeExecutable = await resolveNodeExecutable();
const temporaryProjects: TemporaryProject[] = [];

afterAll(async () => {
  await Promise.all(temporaryProjects.splice(0).map((project) => project.cleanup()));
});

async function compileTree(
  tree: ProjectTree,
  // 引擎 starter 的 provides 里有 @reforce/web-core 的文件坐标（dist/adapter.d.ts#WebEngineAdapter），
  // 那是要落到真实磁盘上解析的，与根导出走 export-binding 短路的装饰器不同。
  options: { readonly linkWeb?: boolean; readonly linkLogging?: boolean } = {},
): Promise<{
  readonly project: TemporaryProject;
  readonly result: CompileResult;
}> {
  const project = await createTemporaryProject(tree);
  temporaryProjects.push(project);
  if (options.linkWeb === true) {
    await linkWebPackage(project.projectRoot);
  }
  if (options.linkLogging === true) {
    await linkLoggingPackage(project.projectRoot);
  }
  const compiler = createCompiler();
  const resolution = await compiler.resolveProject({ projectDirectory: project.projectRoot });
  if (resolution.status === "failure") {
    throw new Error(JSON.stringify(resolution.diagnostics));
  }
  return { project, result: await compiler.compile({ project: resolution.project }) };
}

function webApplicationTsconfig(): string {
  return `${JSON.stringify({
    compilerOptions: {
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      paths: { "@/*": ["./src/*"] },
    },
    include: ["src", ".reforce/generated/**/*.ts"],
  })}\n`;
}

async function compileSources(
  sources: Record<string, string>,
  // 槽位契约要过 checker:参数类型里引用 @reforce/web-core 的别名(Param 等)时,tsgo 需要真实
  // node_modules 才能解析,linkWeb 在编译前把构建产物链好。纯语法层用例不需要。
  options: { readonly linkWeb?: boolean } = {},
): Promise<CompileResult> {
  const { result } = await compileTree(
    {
      "tsconfig.json": webApplicationTsconfig(),
      src: sources,
    },
    options,
  );
  return result;
}

async function compileSourcesOrThrow(
  sources: Record<string, string>,
  options: { readonly linkWeb?: boolean } = {},
): Promise<CompileSuccess> {
  const result = await compileSources(sources, options);
  if (result.status === "failure") {
    throw new Error(JSON.stringify(result.diagnostics));
  }
  return result;
}

function expectFailure(result: CompileResult): FailureResult {
  expect(result.status).toBe("failure");
  if (result.status !== "failure") {
    throw new Error("Expected a failed compilation");
  }
  return result;
}

function failureCodes(result: CompileResult): readonly string[] {
  return expectFailure(result).diagnostics.map((item) => item.code);
}

function generatedContent(result: CompileSuccess, filePath: GeneratedFile["path"]): string {
  const content = result.files.find((file) => file.path === filePath)?.content;
  if (content === undefined) {
    throw new Error(`Missing generated file ${filePath}`);
  }
  return content;
}

interface RouteManifestMiddleware {
  readonly beanId: string;
  readonly phase: string;
  readonly order: number;
  readonly mount: string;
}

interface RouteManifestRoute {
  readonly method: string;
  readonly path: string;
  readonly controller: {
    readonly beanId: string;
    readonly handler: string;
    readonly moduleSpecifier: string;
    readonly exportName: string;
  };
  readonly middleware: readonly RouteManifestMiddleware[];
  readonly meta: Record<string, unknown>;
  readonly contract: unknown;
  readonly source: unknown;
}

interface RouteManifest {
  readonly schemaVersion: number;
  readonly routes: readonly RouteManifestRoute[];
  readonly errorHandlers: readonly { readonly beanId: string; readonly order: number }[];
}

function routeManifestOf(result: CompileSuccess): RouteManifest {
  return JSON.parse(generatedContent(result, "routes.json"));
}

const passthroughSchemaSource = [
  "function passthrough() {",
  '  return { "~standard": { version: 1, vendor: "it", validate: (value: unknown) => ({ value }) } };',
  "}",
  "export const idParamsSchema = passthrough();",
  "export const userResponseSchema = passthrough();",
].join("\n");

describe("route table generation", () => {
  const sources = {
    "markers.ts": [
      'import { defineRouteMarker } from "@reforce/web-core";',
      'export const Roles = defineRouteMarker<readonly string[]>("roles");',
    ].join("\n"),
    "trace.ts": [
      'import { Injectable } from "@reforce/core";',
      'import { Middleware } from "@reforce/web-core";',
      '@Middleware({ phase: "observability", order: -5, global: true })',
      "export class TraceMiddleware {}",
    ].join("\n"),
    "auth.ts": [
      'import { Injectable } from "@reforce/core";',
      'import { Middleware } from "@reforce/web-core";',
      '@Middleware({ phase: "admission" })',
      "export class AuthMiddleware {}",
    ].join("\n"),
    "errors.ts": [
      'import { Injectable } from "@reforce/core";',
      'import { ErrorHandler } from "@reforce/web-core";',
      "@ErrorHandler({ order: 2 })",
      "export class TeapotHandler {}",
      "@ErrorHandler({ order: 1 })",
      "export class FirstHandler {}",
    ].join("\n"),
    "users-controller.ts": [
      'import { Injectable } from "@reforce/core";',
      'import { Controller, Get, type Param, Post, Use } from "@reforce/web-core";',
      'import { AuthMiddleware } from "@/auth";',
      'import { Roles } from "@/markers";',
      '@Controller("/users") @Use(AuthMiddleware)',
      "export class UsersController {",
      '  @Get("/:id")',
      '  @Roles(["admin"])',
      '  show(_id: Param<"id", bigint>): void {}',
      "",
      "  @Post()",
      "  create(): void {}",
      "}",
    ].join("\n"),
  };

  test("emits the route table manifest with flattened chains, meta, and contract nodes", async () => {
    const result = await compileSourcesOrThrow(sources, { linkWeb: true });

    expect(routeManifestOf(result)).toEqual({
      schemaVersion: 4,
      routes: [
        {
          method: "POST",
          path: "/users",
          controller: {
            beanId: "src/users-controller.ts#UsersController",
            handler: "create",
            moduleSpecifier: "../../src/users-controller.js",
            exportName: "UsersController",
          },
          middleware: [
            {
              beanId: "src/trace.ts#TraceMiddleware",
              phase: "observability",
              order: -5,
              mount: "global",
            },
            {
              beanId: "src/auth.ts#AuthMiddleware",
              phase: "admission",
              order: 0,
              mount: "controller",
            },
          ],
          meta: {},
          // 零参 handler = 空槽位;void 返回 = passthrough 响应(#274)。
          contract: { slots: [], response: { kind: "passthrough" } },
          source: expect.anything(),
        },
        {
          method: "GET",
          path: "/users/:id",
          controller: {
            beanId: "src/users-controller.ts#UsersController",
            handler: "show",
            moduleSpecifier: "../../src/users-controller.js",
            exportName: "UsersController",
          },
          middleware: [
            {
              beanId: "src/trace.ts#TraceMiddleware",
              phase: "observability",
              order: -5,
              mount: "global",
            },
            {
              beanId: "src/auth.ts#AuthMiddleware",
              phase: "admission",
              order: 0,
              mount: "controller",
            },
          ],
          meta: { roles: ["admin"] },
          contract: {
            slots: [
              {
                slot: "param",
                key: "id",
                form: "single",
                source: { source: "type" },
                table: {
                  root: { kind: "scalar", scalar: "bigint", nullable: false },
                  definitions: {},
                },
              },
            ],
            response: { kind: "passthrough" },
          },
          source: expect.anything(),
        },
      ],
      errorHandlers: [
        { beanId: "src/errors.ts#FirstHandler", order: 1 },
        { beanId: "src/errors.ts#TeapotHandler", order: 2 },
      ],
    });
  });

  test("emits an executable routes.ts with slot decoders and typed invoke closures", async () => {
    const result = await compileSourcesOrThrow(sources, { linkWeb: true });

    const routesModule = generatedContent(result, "routes.ts");
    // 发射了解码器常量,StandardSchemaV1 才进 import(带标注的常量要过用户项目的 noUnusedLocals)。
    expect(routesModule).toContain(
      'import type { GeneratedRouteTable, RequestContext, StandardSchemaV1 } from "@reforce/web-core/generated-runtime";',
    );
    // 数据槽路由的 invoke:槽值经渲染的契约类型文本一次 as 断言(typed-edge,运行时解码器
    // 已兑现该类型);路由按 (path, method) 排序,/users POST 在前,/users/:id GET 是第 1 条。
    expect(routesModule).toContain(
      "invoke: (instance: InstanceType<typeof webTarget4>, _context: RequestContext, slots: readonly unknown[]) => instance.show(slots[0] as bigint),",
    );
    expect(routesModule).toContain('{ slot: "param", key: "id", decode: webDecode1_0 },');
    // 零参 handler:空槽位,形参全下划线。
    expect(routesModule).toContain(
      "invoke: (instance: InstanceType<typeof webTarget4>, _context: RequestContext, _slots: readonly unknown[]) => instance.create(),",
    );
    expect(routesModule).toContain("slots: [],");
    expect(routesModule).toContain("} as const satisfies GeneratedRouteTable;");
  });

  test("compiles the same route table byte for byte across two fresh compilations", async () => {
    const first = await compileSourcesOrThrow(sources, { linkWeb: true });
    const second = await compileSourcesOrThrow(sources, { linkWeb: true });

    expect(generatedContent(second, "routes.json")).toBe(generatedContent(first, "routes.json"));
    expect(generatedContent(second, "routes.ts")).toBe(generatedContent(first, "routes.ts"));
  });

  test("emits an import-free empty table when the application has no web declarations", async () => {
    const result = await compileSourcesOrThrow({
      "service.ts": [
        'import { Injectable } from "@reforce/core";',
        "@Injectable() export class Service {}",
      ].join("\n"),
    });

    expect(routeManifestOf(result)).toEqual({ schemaVersion: 4, routes: [], errorHandlers: [] });
    expect(generatedContent(result, "routes.ts")).toBe(
      "export const routeTable = {\n  schemaVersion: 4,\n  routes: [],\n  errorHandlers: [],\n} as const;\n",
    );
  });
});

describe("route conflicts", () => {
  test("the same method and path registered twice is a hard error with both sites", async () => {
    const result = await compileSources({
      "a-controller.ts": [
        'import { Injectable } from "@reforce/core";',
        'import { Controller, Get } from "@reforce/web-core";',
        '@Controller("/users")',
        "export class AController {",
        '  @Get("/list")',
        "  list(): void {}",
        "}",
      ].join("\n"),
      "b-controller.ts": [
        'import { Injectable } from "@reforce/core";',
        'import { Controller, Get } from "@reforce/web-core";',
        "@Controller()",
        "export class BController {",
        '  @Get("/users/list")',
        "  list(): void {}",
        "}",
      ].join("\n"),
    });

    const failure = expectFailure(result);
    expect(failure.diagnostics.map((item) => item.code)).toEqual(["DUPLICATE_ROUTE"]);
    expect(failure.diagnostics[0]?.related).toHaveLength(1);
  });

  test("parameter names do not disambiguate the same path shape", async () => {
    const result = await compileSources({
      "controller.ts": [
        'import { Injectable } from "@reforce/core";',
        'import { Controller, Get } from "@reforce/web-core";',
        "@Controller()",
        "export class UsersController {",
        '  @Get("/users/:id")',
        "  byId(): void {}",
        '  @Get("/users/:name")',
        "  byName(): void {}",
        "}",
      ].join("\n"),
    });

    expect(failureCodes(result)).toEqual(["DUPLICATE_ROUTE"]);
  });

  test("the same shape on different methods is not a conflict", async () => {
    const result = await compileSourcesOrThrow({
      "controller.ts": [
        'import { Injectable } from "@reforce/core";',
        'import { Controller, Delete, Get } from "@reforce/web-core";',
        "@Controller()",
        "export class UsersController {",
        '  @Get("/users/:id")',
        "  show(): void {}",
        '  @Delete("/users/:id")',
        "  remove(): void {}",
        "}",
      ].join("\n"),
    });

    expect(routeManifestOf(result).routes.map((route) => route.method)).toEqual(["DELETE", "GET"]);
  });
});

describe("middleware chain flattening", () => {
  test("phase wins over order and beanId; order wins inside a phase; beanId breaks ties", async () => {
    const result = await compileSourcesOrThrow({
      "middleware.ts": [
        'import { Injectable } from "@reforce/core";',
        'import { Middleware } from "@reforce/web-core";',
        // 阶段决胜：application 阶段的 order=-10 也排在 admission 阶段的 order=99 之后。
        '@Middleware({ phase: "application", order: -10, global: true })',
        "export class AppFirst {}",
        '@Middleware({ phase: "admission", order: 99, global: true })',
        "export class AdmissionLate {}",
        // 阶段内 order 决胜。
        '@Middleware({ phase: "admission", order: 1, global: true })',
        "export class AdmissionEarly {}",
        // 同阶段同 order：beanId 决胜（Alpha < Zulu）。
        '@Middleware({ phase: "observability", order: 0, global: true })',
        "export class ZuluTrace {}",
        '@Middleware({ phase: "observability", order: 0, global: true })',
        "export class AlphaTrace {}",
      ].join("\n"),
      "controller.ts": [
        'import { Injectable } from "@reforce/core";',
        'import { Controller, Get } from "@reforce/web-core";',
        "@Controller()",
        "export class PingController {",
        '  @Get("/ping")',
        "  ping(): void {}",
        "}",
      ].join("\n"),
    });

    const route = routeManifestOf(result).routes[0];
    expect(route?.middleware.map((middleware) => middleware.beanId)).toEqual([
      "src/middleware.ts#AlphaTrace",
      "src/middleware.ts#ZuluTrace",
      "src/middleware.ts#AdmissionEarly",
      "src/middleware.ts#AdmissionLate",
      "src/middleware.ts#AppFirst",
    ]);
  });

  test("global, controller, and route mounts merge with mount provenance and no duplicates", async () => {
    const result = await compileSourcesOrThrow({
      "middleware.ts": [
        'import { Injectable } from "@reforce/core";',
        'import { Middleware } from "@reforce/web-core";',
        '@Middleware({ phase: "observability", global: true })',
        "export class TraceMiddleware {}",
        '@Middleware({ phase: "admission" })',
        "export class AuthMiddleware {}",
        '@Middleware({ phase: "application", order: 7 })',
        "export class AuditMiddleware {}",
      ].join("\n"),
      "controller.ts": [
        'import { Injectable } from "@reforce/core";',
        'import { Controller, Get, Use } from "@reforce/web-core";',
        'import { AuditMiddleware, AuthMiddleware, TraceMiddleware } from "@/middleware";',
        "@Controller() @Use(AuthMiddleware)",
        "export class PingController {",
        '  @Get("/ping")',
        "  @Use(AuditMiddleware, TraceMiddleware)",
        "  ping(): void {}",
        "}",
      ].join("\n"),
    });

    const route = routeManifestOf(result).routes[0];
    expect(route?.middleware).toEqual([
      {
        beanId: "src/middleware.ts#TraceMiddleware",
        phase: "observability",
        order: 0,
        mount: "global",
      },
      {
        beanId: "src/middleware.ts#AuthMiddleware",
        phase: "admission",
        order: 0,
        mount: "controller",
      },
      {
        beanId: "src/middleware.ts#AuditMiddleware",
        phase: "application",
        order: 7,
        mount: "route",
      },
    ]);
  });
});

describe("route marker extraction", () => {
  test("a marker value outside the JSON literal tree is rejected in place", async () => {
    const result = await compileSources({
      "markers.ts": [
        'import { defineRouteMarker } from "@reforce/web-core";',
        'export const Roles = defineRouteMarker<readonly string[]>("roles");',
      ].join("\n"),
      "controller.ts": [
        'import { Injectable } from "@reforce/core";',
        'import { Controller, Get } from "@reforce/web-core";',
        'import { Roles } from "@/markers";',
        'const adminRoles = ["admin"] as const;',
        "@Controller()",
        "export class UsersController {",
        '  @Get("/users")',
        "  @Roles(adminRoles)",
        "  list(): void {}",
        "}",
      ].join("\n"),
    });

    expect(failureCodes(result)).toEqual(["INVALID_ROUTE_MARKER_VALUE"]);
  });

  test("a marker declaration without a string literal key is rejected", async () => {
    const result = await compileSources({
      "markers.ts": [
        'import { defineRouteMarker } from "@reforce/web-core";',
        'const key = "roles";',
        "export const Roles = defineRouteMarker<readonly string[]>(key);",
      ].join("\n"),
      "controller.ts": [
        'import { Injectable } from "@reforce/core";',
        "@Injectable() export class Service {}",
      ].join("\n"),
    });

    expect(failureCodes(result)).toEqual(["INVALID_ROUTE_MARKER"]);
  });

  test("a marker declared as let is rejected", async () => {
    const result = await compileSources({
      "markers.ts": [
        'import { defineRouteMarker } from "@reforce/web-core";',
        'export let Roles = defineRouteMarker<readonly string[]>("roles");',
      ].join("\n"),
    });

    expect(failureCodes(result)).toEqual(["INVALID_ROUTE_MARKER"]);
  });

  test("the same marker key twice on one route is rejected with both sites", async () => {
    const result = await compileSources({
      "markers.ts": [
        'import { defineRouteMarker } from "@reforce/web-core";',
        'export const Roles = defineRouteMarker<readonly string[]>("roles");',
      ].join("\n"),
      "controller.ts": [
        'import { Injectable } from "@reforce/core";',
        'import { Controller, Get } from "@reforce/web-core";',
        'import { Roles } from "@/markers";',
        "@Controller()",
        "export class UsersController {",
        '  @Get("/users")',
        '  @Roles(["admin"])',
        '  @Roles(["auditor"])',
        "  list(): void {}",
        "}",
      ].join("\n"),
    });

    const failure = expectFailure(result);
    expect(failure.diagnostics.map((item) => item.code)).toEqual(["INVALID_ROUTE_MARKER_VALUE"]);
    expect(failure.diagnostics[0]?.related).toHaveLength(1);
  });

  // key 空间是全局的（#254）：meta 表按裸字符串 key 存，撞 key 的两个 marker 互为别名。
  test("two declarations sharing one key across files are rejected with both sites", async () => {
    const result = await compileSources({
      "audit-markers.ts": [
        'import { defineRouteMarker } from "@reforce/web-core";',
        'export const AuditRoles = defineRouteMarker<readonly string[]>("roles");',
      ].join("\n"),
      "markers.ts": [
        'import { defineRouteMarker } from "@reforce/web-core";',
        'export const Roles = defineRouteMarker<readonly string[]>("roles");',
      ].join("\n"),
    });

    const failure = expectFailure(result);
    expect(failure.diagnostics.map((item) => item.code)).toEqual(["DUPLICATE_ROUTE_MARKER"]);
    expect(failure.diagnostics[0]?.message).toContain("AuditRoles");
    expect(failure.diagnostics[0]?.related).toHaveLength(1);
    expect(JSON.stringify(failure.diagnostics)).toContain("src/audit-markers.ts");
    expect(JSON.stringify(failure.diagnostics)).toContain("src/markers.ts");
  });

  test("every later declaration of a taken key is reported against the deterministic first", async () => {
    const result = await compileSources({
      "alpha-markers.ts": [
        'import { defineRouteMarker } from "@reforce/web-core";',
        'export const AlphaRoles = defineRouteMarker<readonly string[]>("roles");',
      ].join("\n"),
      "beta-markers.ts": [
        'import { defineRouteMarker } from "@reforce/web-core";',
        'export const BetaRoles = defineRouteMarker<readonly string[]>("roles");',
      ].join("\n"),
      "gamma-markers.ts": [
        'import { defineRouteMarker } from "@reforce/web-core";',
        'export const GammaRoles = defineRouteMarker<readonly string[]>("roles");',
      ].join("\n"),
    });

    const failure = expectFailure(result);
    expect(failure.diagnostics.map((item) => item.code)).toEqual([
      "DUPLICATE_ROUTE_MARKER",
      "DUPLICATE_ROUTE_MARKER",
    ]);
    for (const item of failure.diagnostics) {
      expect(item.message).toContain("AlphaRoles");
    }
  });

  test("distinct keys in separate files stay independent", async () => {
    const result = await compileSources({
      "audit-markers.ts": [
        'import { defineRouteMarker } from "@reforce/web-core";',
        'export const Audit = defineRouteMarker<boolean>("audit");',
      ].join("\n"),
      "markers.ts": [
        'import { defineRouteMarker } from "@reforce/web-core";',
        'export const Roles = defineRouteMarker<readonly string[]>("roles");',
      ].join("\n"),
    });

    expect(result.status).toBe("success");
  });
});

// 旧 `@Get(path, schemas)` 链路已随 RFC 0012 S2 删除:第二实参一律迁移硬错,方法不进任何
// 分析路径,不产生二次诊断。
describe("route schemas argument migration", () => {
  test("a schemas argument is a single migration hard error pointing at the argument", async () => {
    const result = await compileSources({
      "schemas.ts": passthroughSchemaSource,
      "controller.ts": [
        'import { Injectable } from "@reforce/core";',
        'import { Controller, Get } from "@reforce/web-core";',
        'import { idParamsSchema } from "@/schemas";',
        "@Controller()",
        "export class UsersController {",
        '  @Get("/users/:id", { params: idParamsSchema })',
        "  show(): void {}",
        "}",
      ].join("\n"),
    });

    const failure = expectFailure(result);
    expect(failure.diagnostics.map((item) => item.code)).toEqual(["INVALID_ROUTE_SCHEMA"]);
    expect(failure.diagnostics[0]?.message).toContain("no longer accept a schemas argument");
    expect(failure.diagnostics[0]?.help).toContain("typed handler parameters");
  });

  test("an inline schemas object gets the same migration error", async () => {
    const result = await compileSources({
      "controller.ts": [
        'import { Injectable } from "@reforce/core";',
        'import { Controller, Get } from "@reforce/web-core";',
        "@Controller()",
        "export class UsersController {",
        '  @Get("/users", { response: { "~standard": {} } })',
        "  list(): void {}",
        "}",
      ].join("\n"),
    });

    expect(failureCodes(result)).toEqual(["INVALID_ROUTE_SCHEMA"]);
  });
});

describe("web role validation", () => {
  test("route decorators without @Controller are rejected", async () => {
    const result = await compileSources({
      "controller.ts": [
        'import { Injectable } from "@reforce/core";',
        'import { Get } from "@reforce/web-core";',
        "@Injectable()",
        "export class UsersController {",
        '  @Get("/users")',
        "  list(): void {}",
        "}",
      ].join("\n"),
    });

    expect(failureCodes(result)).toEqual(["INVALID_ROUTE_DECLARATION"]);
  });

  test("a controller marked @Injectable is rejected: the role decorator already declares the Bean", async () => {
    const result = await compileSources({
      "controller.ts": [
        'import { Injectable } from "@reforce/core";',
        'import { Controller, Get } from "@reforce/web-core";',
        "@Injectable() @Controller()",
        "export class UsersController {",
        '  @Get("/users")',
        "  list(): void {}",
        "}",
      ].join("\n"),
    });

    expect(failureCodes(result)).toEqual(["INVALID_DECORATOR_USAGE"]);
  });

  test("a controller without @Injectable is a Bean: the role decorator implies it", async () => {
    const result = await compileSourcesOrThrow({
      "controller.ts": [
        'import { Controller, Get } from "@reforce/web-core";',
        "@Controller()",
        "export class UsersController {",
        '  @Get("/users")',
        "  list(): void {}",
        "}",
      ].join("\n"),
    });

    expect(routeManifestOf(result).routes.map((route) => route.controller.beanId)).toEqual([
      "src/controller.ts#UsersController",
    ]);
  });

  test("a request-scoped middleware is rejected", async () => {
    const result = await compileSources({
      "middleware.ts": [
        'import { RequestScoped } from "@reforce/core";',
        'import { Middleware } from "@reforce/web-core";',
        "@RequestScoped() @Middleware({ global: true })",
        "export class SessionMiddleware {}",
      ].join("\n"),
    });

    expect(failureCodes(result)).toEqual(["INVALID_ROUTE_DECLARATION"]);
  });

  test("an unknown middleware phase is rejected", async () => {
    const result = await compileSources({
      "middleware.ts": [
        'import { Injectable } from "@reforce/core";',
        'import { Middleware } from "@reforce/web-core";',
        '@Middleware({ phase: "security" })',
        "export class SecurityMiddleware {}",
      ].join("\n"),
    });

    expect(failureCodes(result)).toEqual(["INVALID_MIDDLEWARE_DECLARATION"]);
  });

  test("Use only accepts middleware Beans", async () => {
    const result = await compileSources({
      "service.ts": [
        'import { Injectable } from "@reforce/core";',
        "@Injectable() export class PlainService {}",
      ].join("\n"),
      "controller.ts": [
        'import { Injectable } from "@reforce/core";',
        'import { Controller, Get, Use } from "@reforce/web-core";',
        'import { PlainService } from "@/service";',
        "@Controller() @Use(PlainService)",
        "export class UsersController {",
        '  @Get("/users")',
        "  list(): void {}",
        "}",
      ].join("\n"),
    });

    expect(failureCodes(result)).toEqual(["INVALID_MIDDLEWARE_DECLARATION"]);
  });
});

describe("full chain over a fake adapter", () => {
  // 契约的最小实现走通全链路（ADR 0006 W1/W4/W7）：编译产表 → tsc 背书生成物 → 假适配器
  // 启动时一次性消费 → 每请求开作用域并播种根请求 bean → 洋葱链（观测/准入/handler）→
  // Current 句柄取请求态 → 槽位解码（:id 生成解码器 string→bigint）→ 返回类型白名单编码
  // （映射漏删的 secret 字段不出线,bigint→字符串）→ 错误处理器兜底。真实引擎适配器是 #153。
  test("a compiled application serves requests through scope, chain, slot decoding, and error handling", async () => {
    const { project, result } = await compileTree(
      {
        "tsconfig.json": webApplicationTsconfig(),
        src: {
          "markers.ts": [
            'import { defineRouteMarker } from "@reforce/web-core";',
            'export const Roles = defineRouteMarker<readonly string[]>("roles");',
          ].join("\n"),
          "log-book.ts": [
            'import { Injectable } from "@reforce/core";',
            "@Injectable()",
            "export class LogBook {",
            "  readonly entries: string[] = [];",
            "}",
          ].join("\n"),
          "request-holder.ts": [
            'import { defineBean } from "@reforce/core";',
            "export class RequestHolder {",
            "  constructor(readonly requestId: string) {}",
            "}",
            "export const requestHolder = defineBean<RequestHolder>({",
            '  scope: "request",',
            '  create: () => new RequestHolder("unseeded"),',
            "});",
          ].join("\n"),
          "trace.ts": [
            'import { Injectable } from "@reforce/core";',
            'import { Middleware, type RequestContext } from "@reforce/web-core";',
            'import { LogBook } from "@/log-book";',
            '@Middleware({ phase: "observability", global: true })',
            "export class TraceMiddleware {",
            "  constructor(private readonly log: LogBook) {}",
            "  async handle(context: RequestContext, next: () => Promise<Response>): Promise<Response> {",
            '    this.log.entries.push("trace:" + context.method + " " + context.path);',
            "    const response = await next();",
            '    this.log.entries.push("trace:" + String(response.status));',
            "    return response;",
            "  }",
            "}",
          ].join("\n"),
          "auth.ts": [
            'import { Injectable } from "@reforce/core";',
            'import { Middleware, type RequestContext } from "@reforce/web-core";',
            'import { LogBook } from "@/log-book";',
            'import { Roles } from "@/markers";',
            '@Middleware({ phase: "admission" })',
            "export class AuthMiddleware {",
            "  constructor(private readonly log: LogBook) {}",
            "  handle(context: RequestContext, next: () => Promise<Response>): Response | Promise<Response> {",
            '    const user = context.request.headers.get("x-user");',
            "    const roles = context.meta(Roles);",
            "    if (roles !== undefined && user === null) {",
            '      return new Response("denied", { status: 403 });',
            "    }",
            '    this.log.entries.push("auth:" + (user ?? "anonymous"));',
            "    return next();",
            "  }",
            "}",
          ].join("\n"),
          "errors.ts": [
            'import { Injectable } from "@reforce/core";',
            'import { ErrorHandler } from "@reforce/web-core";',
            "@ErrorHandler()",
            "export class TeapotHandler {",
            "  handle(error: unknown): Response {",
            '    if (error instanceof Error && error.message === "boom") {',
            '      return new Response("teapot", { status: 418 });',
            "    }",
            "    throw error;",
            "  }",
            "}",
          ].join("\n"),
          "users-controller.ts": [
            'import { type Current, Injectable } from "@reforce/core";',
            'import { Controller, Get, type Param, Use } from "@reforce/web-core";',
            'import { AuthMiddleware } from "@/auth";',
            'import { LogBook } from "@/log-book";',
            'import { Roles } from "@/markers";',
            'import { RequestHolder } from "@/request-holder";',
            '@Controller("/users") @Use(AuthMiddleware)',
            "export class UsersController {",
            "  constructor(",
            "    private readonly holder: Current<RequestHolder>,",
            "    private readonly log: LogBook,",
            "  ) {}",
            "",
            '  @Get("/:id")',
            '  @Roles(["admin"])',
            '  show(id: Param<"id", bigint>): { id: bigint; name: string } {',
            '    this.log.entries.push("handler:show");',
            "    // 白名单编码的靶子:实体多出的 secret 字段不在返回类型契约里,不得出线。",
            '    const entity = { id, name: this.holder.get().requestId, secret: "do-not-leak" };',
            "    return entity;",
            "  }",
            "",
            '  @Get("/explode")',
            "  explode(): Response {",
            '    throw new Error("boom");',
            "  }",
            "}",
          ].join("\n"),
        },
      },
      // Param 槽走 checker,编译前就要链好 @reforce/web-core 的构建产物。
      { linkWeb: true },
    );
    if (result.status === "failure") {
      throw new Error(JSON.stringify(result.diagnostics));
    }
    await linkApplicationPackages(project.projectRoot);
    const generatedDirectory = path.join(project.projectRoot, ".reforce", "generated");
    await mkdir(generatedDirectory, { recursive: true });
    await Promise.all(
      result.files.map((file) => writeFile(path.join(generatedDirectory, file.path), file.content)),
    );
    await writeFile(
      path.join(project.projectRoot, "integration.ts"),
      [
        'import { createWebApplication } from "@reforce/web-core";',
        "import type {",
        "  PreparedRoute,",
        "  WebApplication,",
        "  WebApplicationHandle,",
        "  WebEngineAdapter,",
        '} from "@reforce/web-core/adapter";',
        'import { bootstrap } from "./.reforce/generated/bootstrap.js";',
        'import { routeTable } from "./.reforce/generated/routes.js";',
        'import { LogBook } from "./src/log-book.js";',
        'import { RequestHolder, requestHolder } from "./src/request-holder.js";',
        "",
        "// 契约的最小实现：启动时一次性把 PreparedRoute 收进查找表，热路径只调用 handle。",
        "class FakeAdapter implements WebEngineAdapter {",
        '  readonly name = "fake";',
        "  private readonly byKey = new Map<string, PreparedRoute>();",
        "",
        "  start(application: WebApplication): WebApplicationHandle {",
        "    for (const route of application.routes) {",
        '      this.byKey.set(route.method + " " + route.path, route);',
        "    }",
        "    return { close: () => Promise.resolve() };",
        "  }",
        "",
        "  handle(",
        "    key: string,",
        "    request: Request,",
        "    params: Readonly<Record<string, string>>,",
        "  ): Promise<Response> {",
        "    const route = this.byKey.get(key);",
        "    if (route === undefined) {",
        '      throw new Error("No route for " + key);',
        "    }",
        "    return route.handle(request, params);",
        "  }",
        "}",
        "",
        "const context = await bootstrap();",
        "const application = createWebApplication({",
        "  table: routeTable,",
        "  context,",
        "  requestSeeds: (request) => [",
        "    {",
        "      target: requestHolder,",
        '      instance: new RequestHolder(request.headers.get("x-user") ?? "anonymous"),',
        "    },",
        "  ],",
        "});",
        "const adapter = new FakeAdapter();",
        "await adapter.start(application);",
        "",
        "const ok = await adapter.handle(",
        '  "GET /users/:id",',
        '  new Request("https://it.test/users/42", { headers: { "x-user": "amy" } }),',
        '  { id: "42" },',
        ");",
        "const okBody = await ok.text();",
        "const denied = await adapter.handle(",
        '  "GET /users/:id",',
        '  new Request("https://it.test/users/42"),',
        '  { id: "42" },',
        ");",
        "const exploded = await adapter.handle(",
        '  "GET /users/explode",',
        '  new Request("https://it.test/users/explode", { headers: { "x-user": "amy" } }),',
        "  {},",
        ");",
        "const explodedBody = await exploded.text();",
        "const log = [...context.get(LogBook).entries];",
        "await context.close();",
        "console.log(",
        "  JSON.stringify({",
        "    okStatus: ok.status,",
        "    okBody,",
        "    deniedStatus: denied.status,",
        "    explodedStatus: exploded.status,",
        "    explodedBody,",
        "    log,",
        "  }),",
        ");",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(project.projectRoot, "tsconfig.integration.json"),
      `${JSON.stringify(
        {
          extends: "./tsconfig.json",
          compilerOptions: { noEmit: true },
          include: ["src", ".reforce/generated/**/*.ts", "integration.ts"],
        },
        undefined,
        2,
      )}\n`,
    );
    const typescriptPackage = fileURLToPath(import.meta.resolve("typescript/package.json"));
    const typecheck = await runCommand(
      process.execPath,
      [path.join(path.dirname(typescriptPackage), "bin", "tsc"), "-p", "tsconfig.integration.json"],
      { cwd: project.projectRoot },
    );
    expect(typecheck.exitCode).toBe(0);
    expect(typecheck.stderr).toBe("");

    await bundleEntry({ entry: "integration.ts", cwd: project.projectRoot, outdir: "dist" });
    const execution = await runCommand(
      nodeExecutable,
      [path.join(project.projectRoot, "dist", "integration.js")],
      { cwd: project.projectRoot },
    );
    expect(execution.exitCode).toBe(0);
    expect(JSON.parse(String(execution.stdout))).toEqual({
      okStatus: 200,
      okBody: '{"id":"42","name":"amy"}',
      deniedStatus: 403,
      explodedStatus: 418,
      explodedBody: "teapot",
      log: [
        "trace:GET /users/:id",
        "auth:amy",
        "handler:show",
        "trace:200",
        "trace:GET /users/:id",
        "trace:403",
        "trace:GET /users/explode",
        "auth:amy",
        "trace:418",
      ],
    });
  });
});

// web 引擎接线（ADR 0006 W2 的 #153 修订，约定见 web-model.ts）：runtimeExport 导出名为
// "WebEngine" 的 starter bean 即引擎——bootstrap 是它的需求方（无需 role:"root"），
// 生成的 bootstrap 把路由表与容器交给 connectWebApplication，close 先排空引擎再走容器关闭序。
describe("web engine wiring", () => {
  // 引擎身份认的是 provides 里的 WebEngineAdapter 契约，不是导出名（见 web-model.ts）。
  // exportName 可变就是为了让"命名不是 WebEngine 的引擎"成为可测形态。
  function webEngineStarter(dist: ProjectTree, exportName = "WebEngine"): ProjectTree {
    return starterPackage({
      name: "@acme/web-engine",
      meta: {
        schemaVersion: 1,
        starterDeps: [],
        symbols: [
          { id: `@acme/web-engine#${exportName}`, file: "dist/index.d.ts", subpaths: ["."] },
        ],
        beans: [
          {
            id: `@acme/web-engine#${exportName}`,
            runtimeExport: { module: "@acme/web-engine", export: exportName },
            provides: [
              `@acme/web-engine#${exportName}`,
              "@reforce/web-core:dist/adapter.d.ts#WebEngineAdapter",
            ],
            dependencies: [],
            source: starterMetaSpan("src/engine.ts"),
          },
        ],
      },
      dist,
    });
  }

  function engineDeclaration(exportName = "WebEngine"): string {
    return [
      'import type { WebApplication, WebApplicationHandle } from "@reforce/web-core/adapter";',
      `export declare class ${exportName} {`,
      "  readonly name: string;",
      "  start(application: WebApplication): WebApplicationHandle;",
      "}",
      starterHandleDeclaration("webEngine"),
      "",
    ].join("\n");
  }

  function engineRuntime(exportName = "WebEngine"): string {
    return [
      `export class ${exportName} {`,
      '  name = "fake-engine";',
      "  start(application) {",
      '    globalThis.__wiring.push("engine:start:" + application.routes.length);',
      "    return {",
      "      close: () => {",
      '        globalThis.__wiring.push("engine:close");',
      "        return Promise.resolve();",
      "      },",
      "    };",
      "  }",
      "}",
      starterHandleRuntime("webEngine"),
      "",
    ].join("\n");
  }

  function wiringTree(sources: Record<string, string>, exportName = "WebEngine"): ProjectTree {
    return {
      "tsconfig.json": webApplicationTsconfig(),
      src: sources,
      node_modules: nodeModulesTree({
        "@acme/web-engine": webEngineStarter(
          {
            "index.js": engineRuntime(exportName),
            "index.d.ts": engineDeclaration(exportName),
          },
          exportName,
        ),
      }),
    };
  }

  const pingController = [
    'import { Injectable } from "@reforce/core";',
    'import { Controller, Get } from "@reforce/web-core";',
    '@Controller("/ping")',
    "export class PingController {",
    "  @Get()",
    "  ping(): Response {",
    '    return new Response("pong");',
    "  }",
    "}",
    "",
  ].join("\n");

  function applicationSource(seeder: "exported" | "missing" | "unexported"): string {
    const seederLine =
      seeder === "missing"
        ? []
        : [`${seeder === "exported" ? "export " : ""}const webRequestSeeder = () => [];`];
    return [
      'import { defineApplication } from "@reforce/core";',
      'import { webEngine } from "@acme/web-engine";',
      ...seederLine,
      "export default defineApplication({ starters: [webEngine] });",
      "",
    ].join("\n");
  }

  test("registering a web engine starter wires the generated bootstrap", async () => {
    const { result } = await compileTree(
      wiringTree({
        "application.ts": applicationSource("exported"),
        "ping-controller.ts": pingController,
      }),
      { linkWeb: true },
    );
    if (result.status === "failure") {
      throw new Error(JSON.stringify(result.diagnostics));
    }

    expect(generatedContent(result, "bootstrap.ts")).toBe(
      [
        'import { createApplicationContext } from "@reforce/core/generated-runtime";',
        'import { connectWebApplication } from "@reforce/web-core/generated-runtime";',
        'import { WebEngine as webEngine0 } from "@acme/web-engine";',
        'import { webRequestSeeder as webSeeder0 } from "../../src/application.js";',
        'import { applicationDefinition } from "./beans.js";',
        'import { routeTable } from "./routes.js";',
        "",
        "export async function bootstrap() {",
        "  const application = createApplicationContext(applicationDefinition);",
        "  await application.start();",
        "  return await connectWebApplication({",
        "    context: application,",
        "    table: routeTable,",
        "    engines: [webEngine0],",
        "    requestSeeds: webSeeder0,",
        "  });",
        "}",
        "",
      ].join("\n"),
    );
    const manifest = JSON.parse(generatedContent(result, "manifest.json")) as {
      beans: readonly { id: string; origin: string }[];
    };
    expect(manifest.beans.map((bean) => bean.id)).toContain("@acme/web-engine#WebEngine");
    // starter 包内文件不进 watch 面（#153）：包内容视为不可变，重建信号走项目内 manifest；
    // symlink 场景下这些 realpath 会把 dev watcher 拖进项目外目录的失控扫描。context 侧的
    // node_modules 目录由 watcher 的具名段忽略兜底，这里只钉文件面。
    expect(
      result.watchInputs.fileDependencies.filter((dependency) => dependency.includes("web-engine")),
    ).toEqual([]);
  });

  // 装了日志绑定的 web 应用是唯一走得到摘要分支的形状：logger-synthesis.spec.ts 的树有
  // LoggerFactory 没引擎，上面那棵树有引擎没 LoggerFactory，两边都到不了这里。
  // RFC 0011 的运行期观测项（C6 的台账、后续的崩溃与关停接线）都要对着这棵树断言。
  const loggerFactorySource = [
    'import { Injectable } from "@reforce/core";',
    'import type { Logger, LoggerFactory } from "@reforce/logging";',
    "",
    "@Injectable()",
    "export class TestLoggerFactory implements LoggerFactory {",
    "  create(name: string): Logger {",
    "    return {",
    "      isEnabled: () => true,",
    "      trace() {},",
    "      debug() {},",
    "      info() {},",
    "      warn() {},",
    "      error() {},",
    "      fatal() {},",
    "    };",
    "  }",
    "}",
    "",
  ].join("\n");

  function compileWebWithLogging() {
    return compileTree(
      wiringTree({
        "application.ts": [
          'export * from "@/logger-factory";',
          'import { defineApplication } from "@reforce/core";',
          'import { webEngine } from "@acme/web-engine";',
          "export default defineApplication({ starters: [webEngine] });",
          "",
        ].join("\n"),
        "logger-factory.ts": loggerFactorySource,
        "ping-controller.ts": pingController,
      }),
      { linkWeb: true, linkLogging: true },
    );
  }

  // C6（RFC 0011，#250）：台账从 start() 的返回值出，生成的 bootstrap 是唯一同时拿得到
  // 它与框架 logger 的地方。
  test("the generated bootstrap captures the container's start report", async () => {
    const { result } = await compileWebWithLogging();
    if (result.status === "failure") {
      throw new Error(JSON.stringify(result.diagnostics));
    }

    expect(generatedContent(result, "bootstrap.ts")).toContain(
      "const startReport = await application.start()",
    );
  });

  test("the generated bootstrap emits the per-bean timing stream at debug", async () => {
    const { result } = await compileWebWithLogging();
    if (result.status === "failure") {
      throw new Error(JSON.stringify(result.diagnostics));
    }

    expect(generatedContent(result, "bootstrap.ts")).toContain(
      "emitBeanTimings({ logger: contextLog, timings: startReport.beanTimings });",
    );
  });

  test("the generated bootstrap folds slow beans into the startup summary", async () => {
    const { result } = await compileWebWithLogging();
    if (result.status === "failure") {
      throw new Error(JSON.stringify(result.diagnostics));
    }

    expect(generatedContent(result, "bootstrap.ts")).toContain(
      '...beanTimingSections(startReport.beanTimings, "reforce.core"),',
    );
  });

  // 认导出名的旧判据下，命名不符的引擎是静默失败：bean 无需求方 → 不物化 → 连 manifest
  // 都进不去，bootstrap 完全不含 connectWebApplication，零诊断、routes.json 照常产出、
  // 应用能起、端口永不监听。
  test("an engine bean whose export is not named WebEngine still wires the bootstrap", async () => {
    const { result } = await compileTree(
      wiringTree(
        {
          "application.ts": applicationSource("missing"),
          "ping-controller.ts": pingController,
        },
        "HonoEngine",
      ),
      { linkWeb: true },
    );
    if (result.status === "failure") {
      throw new Error(JSON.stringify(result.diagnostics));
    }

    const bootstrap = generatedContent(result, "bootstrap.ts");
    expect(bootstrap).toContain('import { HonoEngine as webEngine0 } from "@acme/web-engine";');
    expect(bootstrap).toContain("engines: [webEngine0],");
    const manifest = JSON.parse(generatedContent(result, "manifest.json")) as {
      beans: readonly { id: string }[];
    };
    expect(manifest.beans.map((bean) => bean.id)).toContain("@acme/web-engine#HonoEngine");
  });

  test("the same wiring compiles to byte-identical bootstrap output", async () => {
    const tree = wiringTree({
      "application.ts": applicationSource("exported"),
      "ping-controller.ts": pingController,
    });
    const first = await compileTree(tree, { linkWeb: true });
    const second = await compileTree(tree, { linkWeb: true });
    if (first.result.status === "failure" || second.result.status === "failure") {
      throw new Error("Expected both compilations to succeed");
    }

    expect(generatedContent(first.result, "bootstrap.ts")).toBe(
      generatedContent(second.result, "bootstrap.ts"),
    );
  });

  test("without webRequestSeeder the bootstrap omits request seeding", async () => {
    const { result } = await compileTree(
      wiringTree({
        "application.ts": applicationSource("missing"),
        "ping-controller.ts": pingController,
      }),
      { linkWeb: true },
    );
    if (result.status === "failure") {
      throw new Error(JSON.stringify(result.diagnostics));
    }

    const bootstrap = generatedContent(result, "bootstrap.ts");
    expect(bootstrap).toContain("engines: [webEngine0],");
    expect(bootstrap).not.toContain("requestSeeds");
    expect(bootstrap).not.toContain("src/application.js");
  });

  test("an unexported webRequestSeeder is a hard error", async () => {
    const { result } = await compileTree(
      wiringTree({
        "application.ts": applicationSource("unexported"),
        "ping-controller.ts": pingController,
      }),
      { linkWeb: true },
    );

    expect(failureCodes(result)).toContain("INVALID_WEB_REQUEST_SEEDER");
  });

  test("an engine without any route still wires an empty table", async () => {
    const { result } = await compileTree(
      wiringTree({
        "application.ts": applicationSource("missing"),
      }),
      { linkWeb: true },
    );
    if (result.status === "failure") {
      throw new Error(JSON.stringify(result.diagnostics));
    }

    expect(generatedContent(result, "bootstrap.ts")).toContain("connectWebApplication");
    expect(JSON.parse(generatedContent(result, "routes.json"))).toEqual({
      schemaVersion: 4,
      routes: [],
      errorHandlers: [],
    });
  });

  test("bootstrap starts the engine and closes it before the container shuts down", async () => {
    const { project, result } = await compileTree(
      wiringTree({
        "application.ts": applicationSource("exported"),
        "ping-controller.ts": pingController,
        "close-probe.ts": [
          'import { Injectable, type OnContextClose } from "@reforce/core";',
          "declare global {",
          "  var __wiring: string[];",
          "}",
          "@Injectable()",
          "export class CloseProbe implements OnContextClose {",
          "  onContextClose(): void {",
          '    globalThis.__wiring.push("bean:close");',
          "  }",
          "}",
          "",
        ].join("\n"),
      }),
      { linkWeb: true },
    );
    if (result.status === "failure") {
      throw new Error(JSON.stringify(result.diagnostics));
    }
    // @reforce/web-core 已由 compileTree 的 linkWeb 在编译前链好，这里只补运行时其余依赖
    await linkApplicationPackages(project.projectRoot);
    const generatedDirectory = path.join(project.projectRoot, ".reforce", "generated");
    await mkdir(generatedDirectory, { recursive: true });
    await Promise.all(
      result.files.map((file) => writeFile(path.join(generatedDirectory, file.path), file.content)),
    );
    await writeFile(
      path.join(project.projectRoot, "runner.ts"),
      [
        'import { bootstrap } from "./.reforce/generated/bootstrap.js";',
        "declare global {",
        "  var __wiring: string[];",
        "}",
        "globalThis.__wiring = [];",
        "const context = await bootstrap();",
        'globalThis.__wiring.push("bootstrapped");',
        "await context.close();",
        "await context.close();",
        "console.log(JSON.stringify(globalThis.__wiring));",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(project.projectRoot, "tsconfig.integration.json"),
      `${JSON.stringify(
        {
          extends: "./tsconfig.json",
          compilerOptions: { noEmit: true },
          include: ["src", ".reforce/generated/**/*.ts", "runner.ts"],
        },
        undefined,
        2,
      )}\n`,
    );
    const typescriptPackage = fileURLToPath(import.meta.resolve("typescript/package.json"));
    const typecheck = await runCommand(
      process.execPath,
      [path.join(path.dirname(typescriptPackage), "bin", "tsc"), "-p", "tsconfig.integration.json"],
      { cwd: project.projectRoot },
    );
    expect(typecheck.exitCode).toBe(0);
    expect(typecheck.stderr).toBe("");

    // runner 经打包执行：应用 src 与生成物里的 TC39 装饰器需 SWC 降级，Node 直跑 TS
    // （type stripping）不处理装饰器（#207）
    await bundleEntry({ entry: "runner.ts", cwd: project.projectRoot, outdir: "dist" });
    const execution = await runCommand(
      nodeExecutable,
      [path.join(project.projectRoot, "dist", "runner.js")],
      { cwd: project.projectRoot },
    );
    expect(execution.exitCode).toBe(0);
    expect(JSON.parse(String(execution.stdout))).toEqual([
      "engine:start:1",
      "bootstrapped",
      "engine:close",
      "bean:close",
    ]);
  });
});
