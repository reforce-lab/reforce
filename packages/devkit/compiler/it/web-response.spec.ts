import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createTemporaryProject,
  runCommand,
  type TemporaryProject,
} from "@reforce/tooling-testing";
import { afterAll, describe, expect, test } from "vitest";
import { type CompileResult, createCompiler, type GeneratedFile } from "@/index";
import { type CompileSuccess, linkApplicationPackages, linkWebPackage } from "./support/project";

// S3 响应侧的 compile 级 IT(RFC 0012 S3,#275):推导与显式同表、推导失败降级 free-form、
// @ResponseStatus/@ResponseSchema/@Throws 的生成物形状、错误处理器 accepts/status/encode
// 发射,以及五个新码的负向。checker 相关全部 linkWeb;算法分支的系统覆盖在
// test/analysis/web-slots.spec.ts(stub 单测)。

type FailureResult = Extract<CompileResult, { readonly status: "failure" }>;

const temporaryProjects: TemporaryProject[] = [];

afterAll(async () => {
  await Promise.all(temporaryProjects.splice(0).map((project) => project.cleanup()));
});

function applicationTsconfig(): string {
  return `${JSON.stringify({
    compilerOptions: {
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      paths: { "@/*": ["./src/*"] },
    },
    include: ["src", ".reforce/generated/**/*.d.ts"],
  })}\n`;
}

async function projectOf(sources: Record<string, string>): Promise<TemporaryProject> {
  const project = await createTemporaryProject({
    "tsconfig.json": applicationTsconfig(),
    src: sources,
  });
  temporaryProjects.push(project);
  await linkWebPackage(project.projectRoot);
  return project;
}

async function compileResponses(sources: Record<string, string>): Promise<{
  readonly project: TemporaryProject;
  readonly result: CompileResult;
}> {
  const project = await projectOf(sources);
  const compiler = createCompiler();
  const resolution = await compiler.resolveProject({ projectDirectory: project.projectRoot });
  if (resolution.status === "failure") {
    throw new Error(JSON.stringify(resolution.diagnostics));
  }
  return { project, result: await compiler.compile({ project: resolution.project }) };
}

async function compileResponsesOrThrow(sources: Record<string, string>): Promise<{
  readonly project: TemporaryProject;
  readonly result: CompileSuccess;
}> {
  const { project, result } = await compileResponses(sources);
  if (result.status === "failure") {
    throw new Error(JSON.stringify(result.diagnostics));
  }
  return { project, result };
}

function failureCodes(result: CompileResult): readonly string[] {
  expect(result.status).toBe("failure");
  return (result as FailureResult).diagnostics.map((item) => item.code);
}

function generatedContent(result: CompileSuccess, filePath: GeneratedFile["path"]): string {
  const content = result.files.find((file) => file.path === filePath)?.content;
  if (content === undefined) {
    throw new Error(`Missing generated file ${filePath}`);
  }
  return content;
}

interface ManifestRoute {
  readonly method: string;
  readonly path: string;
  readonly contract: {
    readonly slots: readonly Record<string, unknown>[];
    readonly response: Record<string, unknown>;
  };
}

interface Manifest {
  readonly schemaVersion: number;
  readonly routes: readonly ManifestRoute[];
  readonly errorHandlers: readonly Record<string, unknown>[];
}

function manifestOf(result: CompileSuccess): Manifest {
  return JSON.parse(generatedContent(result, "routes.json"));
}

function responseOf(result: CompileSuccess, method: string, routePath: string) {
  const route = manifestOf(result).routes.find(
    (entry) => entry.method === method && entry.path === routePath,
  );
  if (route === undefined) {
    throw new Error(`Missing route ${method} ${routePath} in routes.json`);
  }
  return route.contract.response;
}

// 真 tsc 背书生成物(typed-edge 惯用法,同 it/web-routes.spec.ts):生成文件落盘后对
// src + generated 跑一遍 tsc,推导路由与 @ResponseSchema 放宽返回都要过。
async function typecheckGenerated(
  project: TemporaryProject,
  result: CompileSuccess,
): Promise<void> {
  await linkApplicationPackages(project.projectRoot);
  const generatedDirectory = path.join(project.projectRoot, ".reforce", "generated");
  await mkdir(generatedDirectory, { recursive: true });
  await Promise.all(
    result.files.map((file) => writeFile(path.join(generatedDirectory, file.path), file.content)),
  );
  await writeFile(
    path.join(project.projectRoot, "tsconfig.generated.json"),
    `${JSON.stringify({
      extends: "./tsconfig.json",
      compilerOptions: { noEmit: true },
      include: ["src", ".reforce/generated/**/*.ts"],
    })}\n`,
  );
  const typescriptPackage = fileURLToPath(import.meta.resolve("typescript/package.json"));
  const typecheck = await runCommand(
    process.execPath,
    [path.join(path.dirname(typescriptPackage), "bin", "tsc"), "-p", "tsconfig.generated.json"],
    { cwd: project.projectRoot },
  );
  expect(typecheck.stderr).toBe("");
  expect(typecheck.exitCode).toBe(0);
}

const controllerImports = [
  'import { Injectable } from "@reforce/core";',
  "import {",
  "  Controller,",
  "  ErrorHandler,",
  "  Get,",
  "  Middleware,",
  "  Post,",
  "  type RequestContext,",
  "  ResponseSchema,",
  "  ResponseStatus,",
  "  type RouteResponse,",
  "  Throws,",
  "  Use,",
  '} from "@reforce/web-core";',
].join("\n");

// 手写 ~standard 夹具(真 zod 不引入):@ResponseSchema 抽 input 侧要求类型面携带 types。
const schemaSource = [
  "export interface ItSchema<O> {",
  '  readonly "~standard": {',
  "    readonly version: 1;",
  '    readonly vendor: "it";',
  "    readonly validate: (",
  "      value: unknown,",
  "    ) => { value: O } | { issues: readonly { message: string }[] };",
  "    readonly types: { readonly input: O; readonly output: O } | undefined;",
  "  };",
  "}",
  "function schema<O>(): ItSchema<O> {",
  "  return {",
  '    "~standard": {',
  "      version: 1,",
  '      vendor: "it",',
  "      // 夹具只关心类型面,校验行为不在断言范围 // justified: 测试夹具",
  "      validate: (value) => ({ value: value as O }),",
  "      types: undefined,",
  "    },",
  "  };",
  "}",
  "export const orderWireSchema = schema<{ id: string; total: number }>();",
].join("\n");

const errorsSource = [
  controllerImports,
  "export class OrderRejectedError extends Error {",
  "  readonly orderId: bigint = 0n;",
  "}",
  "export class SpecialOrderRejectedError extends OrderRejectedError {}",
  "export class QuotaExceededError extends Error {}",
  "",
  "@ErrorHandler()",
  "@ResponseStatus(409)",
  "export class OrderRejectedHandler {",
  "  handle(error: OrderRejectedError): { code: string; orderId: bigint } {",
  '    return { code: "ORDER_REJECTED", orderId: error.orderId };',
  "  }",
  "}",
  "",
  "@ErrorHandler()",
  "@ResponseStatus(429)",
  "export class QuotaHandler {",
  "  handle(_error: QuotaExceededError): { code: string } {",
  '    return { code: "QUOTA" };',
  "  }",
  "}",
].join("\n");

// defineHttpError 造的异常(#310):无类声明、无处理器,@Throws 直接绑内置 problem+json 契约。
const httpErrorsSource = [
  'import { defineHttpError } from "@reforce/web-core";',
  "",
  "export const PaymentRequiredError = defineHttpError<[name: string]>(",
  '  "PAYMENT_REQUIRED_X",',
  '  "payment %s required",',
  "  402,",
  ");",
  "",
  "// status 不是字面量:静态读不出,manifest 该条目不落 status(文档只收静态可知的事实)。",
  "const teapotStatus = 418;",
  'export const TeapotDynamicError = defineHttpError("TEAPOT_DYNAMIC", "teapot", teapotStatus);',
  "",
  "// status 字面量出 100-599 合法域:同样不落 status——非法状态码进 openapi 只会砸下游。",
  'export const WeirdStatusError = defineHttpError("WEIRD_STATUS", "weird", 42.5);',
].join("\n");

describe("S3 response declarations", () => {
  const sources = {
    "schemas.ts": schemaSource,
    "errors.ts": errorsSource,
    "http-errors.ts": httpErrorsSource,
    "quota-middleware.ts": [
      controllerImports,
      'import { QuotaExceededError } from "@/errors";',
      "@Middleware()",
      "@Throws(QuotaExceededError)",
      "export class QuotaMiddleware {",
      "  handle(_context: RequestContext, next: () => Promise<RouteResponse>): Promise<RouteResponse> {",
      "    return next();",
      "  }",
      "}",
    ].join("\n"),
    "orders-controller.ts": [
      controllerImports,
      'import { OrderRejectedError, SpecialOrderRejectedError } from "@/errors";',
      'import { PaymentRequiredError, TeapotDynamicError, WeirdStatusError } from "@/http-errors";',
      'import { QuotaMiddleware } from "@/quota-middleware";',
      'import { orderWireSchema } from "@/schemas";',
      '@Controller("/orders")',
      "export class OrdersController {",
      "  // 推导模式:无标注,返回类型由 tsc 推出,契约与显式标注完全一致。",
      '  @Get("/inferred")',
      "  inferred() {",
      '    return { id: 1n, name: "amy" };',
      "  }",
      "",
      '  @Get("/declared")',
      "  declared(): { id: bigint; name: string } {",
      '    return { id: 1n, name: "amy" };',
      "  }",
      "",
      "  // 推导失败(经 unknown 的值):静默降级 free-form,不硬错。",
      '  @Get("/loose")',
      "  loose() {",
      "    const value: unknown = { anything: true };",
      "    return value;",
      "  }",
      "",
      '  @Post("/created")',
      "  @ResponseStatus(201)",
      "  created(): { id: bigint } {",
      "    return { id: 1n };",
      "  }",
      "",
      "  // @ResponseSchema:线上契约 = schema input 侧;string 叶放宽,bigint id 过真 tsc。",
      '  @Get("/wire")',
      "  @ResponseSchema(orderWireSchema)",
      "  wire(): { id: bigint; total: number } {",
      "    return { id: 42n, total: 10 };",
      "  }",
      "",
      '  @Get("/throws")',
      "  @Throws(OrderRejectedError)",
      "  @Use(QuotaMiddleware)",
      "  throwing(): void {}",
      "",
      "  // 继承链:@Throws(Sub) 被收 Base 的处理器满足(镜像运行时 instanceof)。",
      '  @Get("/throws-sub")',
      "  @Throws(SpecialOrderRejectedError)",
      "  throwingSub(): void {}",
      "",
      "  // defineHttpError 造的异常与类异常混排(#310)。",
      '  @Get("/throws-http-error")',
      "  @Throws(PaymentRequiredError, OrderRejectedError)",
      "  throwingHttp(): void {}",
      "",
      '  @Get("/throws-http-dynamic")',
      "  @Throws(TeapotDynamicError, WeirdStatusError)",
      "  throwingDynamic(): void {}",
      "}",
    ].join("\n"),
  };

  test("a cleanly inferred response emits the same table and encoder as an explicit one", async () => {
    const { result } = await compileResponsesOrThrow(sources);

    const inferred = responseOf(result, "GET", "/orders/inferred");
    const declared = responseOf(result, "GET", "/orders/declared");
    expect(inferred).toEqual(declared);
    expect(inferred).toMatchObject({ kind: "table", status: 200, source: { source: "type" } });
  });

  test("an uninferable response degrades to free-form with no encoder in routes.ts", async () => {
    const { result } = await compileResponsesOrThrow(sources);

    expect(responseOf(result, "GET", "/orders/loose")).toEqual({
      kind: "free-form",
      status: 200,
    });
    const routesModule = generatedContent(result, "routes.ts");
    expect(routesModule).toContain('response: { kind: "free-form", status: 200 },');
  });

  test("ResponseStatus lands in the table and the manifest", async () => {
    const { result } = await compileResponsesOrThrow(sources);

    expect(responseOf(result, "POST", "/orders/created")).toMatchObject({
      kind: "table",
      status: 201,
    });
    expect(generatedContent(result, "routes.ts")).toContain('{ kind: "table", status: 201,');
  });

  test("ResponseSchema produces a schema-sourced exact table from the input side", async () => {
    const { result } = await compileResponsesOrThrow(sources);

    expect(responseOf(result, "GET", "/orders/wire")).toEqual({
      kind: "table",
      status: 200,
      table: {
        root: {
          kind: "object",
          nullable: false,
          fields: [
            {
              name: "id",
              optional: false,
              shape: { kind: "scalar", scalar: "string", nullable: false },
            },
            {
              name: "total",
              optional: false,
              shape: { kind: "scalar", scalar: "number", nullable: false },
            },
          ],
        },
        definitions: {},
      },
      source: {
        source: "schema",
        schema: { moduleSpecifier: "../../src/schemas.js", exportName: "orderWireSchema" },
        vendor: "it",
      },
    });
  });

  test("Throws unions route and middleware declarations with handler status and body", async () => {
    const { result } = await compileResponsesOrThrow(sources);

    const throwing = responseOf(result, "GET", "/orders/throws");
    expect(throwing.errors).toEqual([
      {
        error: "OrderRejectedError",
        handler: "src/errors.ts#OrderRejectedHandler",
        status: 409,
        body: { kind: "table", table: expect.anything() },
      },
      {
        error: "QuotaExceededError",
        handler: "src/errors.ts#QuotaHandler",
        status: 429,
        body: { kind: "table", table: expect.anything() },
      },
    ]);
    const throwingSub = responseOf(result, "GET", "/orders/throws-sub");
    expect(throwingSub.errors).toEqual([
      {
        error: "SpecialOrderRejectedError",
        handler: "src/errors.ts#OrderRejectedHandler",
        status: 409,
        body: { kind: "table", table: expect.anything() },
      },
    ]);
  });

  test("Throws accepts a defineHttpError const and records the built-in problem contract", async () => {
    const { result } = await compileResponsesOrThrow(sources);

    const throwing = responseOf(result, "GET", "/orders/throws-http-error");
    expect(throwing.errors).toEqual([
      {
        error: "OrderRejectedError",
        handler: "src/errors.ts#OrderRejectedHandler",
        status: 409,
        body: { kind: "table", table: expect.anything() },
      },
      {
        error: "PaymentRequiredError",
        status: 402,
        body: { kind: "problem", code: "PAYMENT_REQUIRED_X" },
      },
    ]);
  });

  test("a defineHttpError with a non-literal status keeps the entry but drops the status", async () => {
    const { result } = await compileResponsesOrThrow(sources);

    const throwing = responseOf(result, "GET", "/orders/throws-http-dynamic");
    expect(throwing.errors).toEqual([
      { error: "TeapotDynamicError", body: { kind: "problem", code: "TEAPOT_DYNAMIC" } },
      { error: "WeirdStatusError", body: { kind: "problem", code: "WEIRD_STATUS" } },
    ]);
  });

  test("typed error handlers emit accepts imports, status and encoders", async () => {
    const { result } = await compileResponsesOrThrow(sources);

    const routesModule = generatedContent(result, "routes.ts");
    expect(routesModule).toContain(
      'import { OrderRejectedError as webError0 } from "../../src/errors.js";',
    );
    expect(routesModule).toContain(
      'import { QuotaExceededError as webError1 } from "../../src/errors.js";',
    );
    expect(routesModule).toContain("accepts: webError0, status: 409, encode: webErrorEncode0");
    expect(routesModule).toContain("accepts: webError1, status: 429, encode: webErrorEncode1");

    const handlers = manifestOf(result).errorHandlers;
    expect(handlers).toEqual([
      {
        beanId: "src/errors.ts#OrderRejectedHandler",
        order: 0,
        accepts: { name: "OrderRejectedError", moduleSpecifier: "../../src/errors.js" },
        status: 409,
        body: { kind: "table", table: expect.anything() },
      },
      {
        beanId: "src/errors.ts#QuotaHandler",
        order: 0,
        accepts: { name: "QuotaExceededError", moduleSpecifier: "../../src/errors.js" },
        status: 429,
        body: { kind: "table", table: expect.anything() },
      },
    ]);
  });

  test("the generated table passes a real tsc pass over src and generated files", async () => {
    const { project, result } = await compileResponsesOrThrow(sources);

    await typecheckGenerated(project, result);
  });
});

describe("S3 response hard errors", () => {
  test("Throws without an accepting typed handler is THROWS_WITHOUT_HANDLER", async () => {
    const { result } = await compileResponses({
      "errors.ts": [
        controllerImports,
        "export class LonelyError extends Error {}",
        "// match-all 处理器不满足 @Throws:线上契约需要状态码与形状。",
        "@ErrorHandler()",
        "export class CatchAllHandler {",
        "  handle(_error: unknown): Response {",
        '    return new Response("caught", { status: 500 });',
        "  }",
        "}",
      ].join("\n"),
      "users-controller.ts": [
        controllerImports,
        'import { LonelyError } from "@/errors";',
        "@Controller()",
        "export class UsersController {",
        '  @Get("/users")',
        "  @Throws(LonelyError)",
        "  list(): void {}",
        "}",
      ].join("\n"),
    });

    expect(failureCodes(result)).toEqual(["THROWS_WITHOUT_HANDLER"]);
  });

  // 限定名不认:按最左标识符解析会把 X.foo 误认成 X,宁可硬错也不落错误声明。
  test("a qualified reference to a defineHttpError const is INVALID_ERROR_HANDLER_SIGNATURE", async () => {
    const { result } = await compileResponses({
      "http-errors.ts": httpErrorsSource,
      "users-controller.ts": [
        controllerImports,
        'import { PaymentRequiredError } from "@/http-errors";',
        "@Controller()",
        "export class UsersController {",
        '  @Get("/users")',
        "  @Throws(PaymentRequiredError.foo)",
        "  list(): void {}",
        "}",
      ].join("\n"),
    });

    expect(failureCodes(result)).toEqual(["INVALID_ERROR_HANDLER_SIGNATURE"]);
  });

  test("a const that is not a defineHttpError call is INVALID_ERROR_HANDLER_SIGNATURE", async () => {
    const { result } = await compileResponses({
      "users-controller.ts": [
        controllerImports,
        "export const notAnError = { status: 402 };",
        "@Controller()",
        "export class UsersController {",
        '  @Get("/users")',
        "  @Throws(notAnError)",
        "  list(): void {}",
        "}",
      ].join("\n"),
    });

    expect(failureCodes(result)).toEqual(["INVALID_ERROR_HANDLER_SIGNATURE"]);
  });

  test("a data-shaped handler without ResponseStatus is ERROR_HANDLER_MISSING_STATUS", async () => {
    const { result } = await compileResponses({
      "errors.ts": [
        controllerImports,
        "export class OrderRejectedError extends Error {}",
        "@ErrorHandler()",
        "export class OrderRejectedHandler {",
        "  handle(_error: OrderRejectedError): { code: string } {",
        '    return { code: "ORDER_REJECTED" };',
        "  }",
        "}",
      ].join("\n"),
    });

    expect(failureCodes(result)).toEqual(["ERROR_HANDLER_MISSING_STATUS"]);
  });

  test("a bodyless status on a data-shaped route is INVALID_RESPONSE_STATUS", async () => {
    const { result } = await compileResponses({
      "users-controller.ts": [
        controllerImports,
        "@Controller()",
        "export class UsersController {",
        '  @Get("/users")',
        "  @ResponseStatus(204)",
        "  list(): { id: bigint } {",
        "    return { id: 1n };",
        "  }",
        "}",
      ].join("\n"),
    });

    expect(failureCodes(result)).toEqual(["INVALID_RESPONSE_STATUS"]);
  });

  test("a ResponseSchema referencing a non-schema value is INVALID_RESPONSE_SCHEMA", async () => {
    const { result } = await compileResponses({
      "shapes.ts": 'export const plainShape = { name: "value" };',
      "users-controller.ts": [
        controllerImports,
        'import { plainShape } from "@/shapes";',
        "@Controller()",
        "export class UsersController {",
        '  @Get("/users")',
        "  // 夹具故意破坏类型契约,验证编译期复检 // justified: 负向测试输入",
        "  @ResponseSchema(plainShape as never)",
        "  list(): { name: string } {",
        '    return { name: "amy" };',
        "  }",
        "}",
      ].join("\n"),
    });

    expect(failureCodes(result)).toEqual(["INVALID_RESPONSE_SCHEMA"]);
  });

  test("a handler accepting an interface is INVALID_ERROR_HANDLER_SIGNATURE", async () => {
    const { result } = await compileResponses({
      "errors.ts": [
        controllerImports,
        "export interface ErrorShape {",
        "  readonly code: string;",
        "}",
        "@ErrorHandler()",
        "@ResponseStatus(400)",
        "export class ShapeHandler {",
        "  handle(_error: ErrorShape): { code: string } {",
        '    return { code: "SHAPE" };',
        "  }",
        "}",
      ].join("\n"),
    });

    expect(failureCodes(result)).toEqual(["INVALID_ERROR_HANDLER_SIGNATURE"]);
  });
});
