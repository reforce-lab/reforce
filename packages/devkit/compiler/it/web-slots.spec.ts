import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ProjectTree } from "@reforce/tooling-testing";
import { createTemporaryProject, type TemporaryProject } from "@reforce/tooling-testing";
import { afterAll, describe, expect, test } from "vitest";
import { type CompileResult, createCompiler, type GeneratedFile } from "@/index";
import { type CompileSuccess, linkWebPackage } from "./support/project";

// 槽位契约的 compile 级 IT(RFC 0012 S2,#274):四种写法(裸标注/单键/契约/投影)与可选单键
// 的生成物断言、六类硬错的 failureCodes、schema typeof 追溯的别名/内联/包裹/降级形态
// (真 zod 不引入,手写 ~standard 夹具)、响应侧三特例,以及 checker 进程经济学——全仓无
// 数据槽不 spawn tsgo、kill 后下一轮编译得 TYPE_CHECKER_UNAVAILABLE、再下一轮自动重建。
// 算法分支的系统覆盖在 test/analysis/web-slots.spec.ts(stub 单测);这里钉真 checker 语义
// 与端到端生成物。

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
    include: ["src", ".reforce/generated/**/*.ts"],
  })}\n`;
}

async function preparedProject(sources: Record<string, string>): Promise<TemporaryProject> {
  const project = await createTemporaryProject({
    "tsconfig.json": applicationTsconfig(),
    src: sources,
  });
  temporaryProjects.push(project);
  // 槽位契约要过 checker:tsgo 解析 @reforce/web-core 的类型需要真实 node_modules。
  await linkWebPackage(project.projectRoot);
  return project;
}

async function compileSlots(sources: Record<string, string>): Promise<CompileResult> {
  const project = await preparedProject(sources);
  const compiler = createCompiler();
  const resolution = await compiler.resolveProject({ projectDirectory: project.projectRoot });
  if (resolution.status === "failure") {
    throw new Error(JSON.stringify(resolution.diagnostics));
  }
  return await compiler.compile({ project: resolution.project });
}

async function compileSlotsOrThrow(sources: Record<string, string>): Promise<CompileSuccess> {
  const result = await compileSlots(sources);
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

function contractOf(result: CompileSuccess, method: string, routePath: string) {
  const manifest = JSON.parse(generatedContent(result, "routes.json")) as {
    readonly routes: readonly ManifestRoute[];
  };
  const route = manifest.routes.find(
    (entry) => entry.method === method && entry.path === routePath,
  );
  if (route === undefined) {
    throw new Error(`Missing route ${method} ${routePath} in routes.json`);
  }
  return route.contract;
}

const controllerImports = [
  'import { Injectable } from "@reforce/core";',
  "import {",
  "  type Body,",
  "  Controller,",
  "  Get,",
  "  type Header,",
  "  type Param,",
  "  Post,",
  "  Put,",
  "  type Query,",
  "  type RequestContext,",
  '} from "@reforce/web-core";',
].join("\n");

describe("slot writing forms", () => {
  const sources = {
    "contracts.ts": [
      "export interface Ids {",
      "  id: bigint;",
      "}",
      "export interface Filter {",
      "  tag: string[];",
      "  limit?: number;",
      "}",
      "export interface CreateUser {",
      "  name: string;",
      "  age: number;",
      "  active: boolean;",
      "  bornAt: Date;",
      "}",
    ].join("\n"),
    "users-controller.ts": [
      controllerImports,
      'import type { CreateUser, Filter, Ids } from "@/contracts";',
      '@Controller("/users")',
      "export class UsersController {",
      "  // 单键 + 可选单键(两种写法) + 三个裸标注:一条路由集齐。",
      '  @Get("/:id")',
      "  show(",
      '    _id: Param<"id", bigint>,',
      '    _page: Query<"page", number | undefined>,',
      '    _tenant: Header<"x-tenant-id" | undefined>,',
      "    _context: RequestContext,",
      "    _request: Request,",
      "    _headers: Headers,",
      "  ): void {}",
      "",
      "  @Get()",
      "  list(_filter: Query<Filter>): void {}",
      "",
      "  @Post()",
      "  create(_body: Body<CreateUser>): void {}",
      "",
      '  @Put("/:id")',
      '  rename(_name: Body<CreateUser, "name">, _id: Param<Ids, "id">): void {}',
      "",
      '  @Get("/tags")',
      '  tags(_tag: Query<"tag", string[]>): void {}',
      "",
      '  @Get("/raw")',
      "  raw(): Response {",
      '    return new Response("ok");',
      "  }",
      "",
      '  @Get("/nothing")',
      "  nothing(): Promise<void> {",
      "    return Promise.resolve();",
      "  }",
      "",
      '  @Get("/dto")',
      "  dto(): Promise<{ id: bigint; name: string }> {",
      '    return Promise.resolve({ id: 1n, name: "amy" });',
      "  }",
      "}",
    ].join("\n"),
  };

  test("single keys, optional single keys and bare annotations land in one contract", async () => {
    const result = await compileSlotsOrThrow(sources);

    expect(contractOf(result, "GET", "/users/:id")).toEqual({
      slots: [
        {
          slot: "param",
          key: "id",
          form: "single",
          source: { source: "type" },
          table: { root: { kind: "scalar", scalar: "bigint", nullable: false }, definitions: {} },
        },
        {
          slot: "query",
          key: "page",
          form: "optional-single",
          source: { source: "type" },
          table: { root: { kind: "scalar", scalar: "number", nullable: false }, definitions: {} },
        },
        {
          slot: "header",
          key: "x-tenant-id",
          form: "optional-single",
          source: { source: "type" },
          table: { root: { kind: "scalar", scalar: "string", nullable: false }, definitions: {} },
        },
        { slot: "requestContext" },
        { slot: "request" },
        { slot: "responseHeaders" },
      ],
      response: { kind: "passthrough" },
    });
  });

  test("contract forms, projections and query arrays keep their keys and tables", async () => {
    const result = await compileSlotsOrThrow(sources);

    const list = contractOf(result, "GET", "/users");
    expect(list.slots).toMatchObject([
      { slot: "query", form: "contract", source: { source: "type" } },
    ]);

    const create = contractOf(result, "POST", "/users");
    expect(create.slots).toMatchObject([{ slot: "body", source: { source: "type" } }]);
    // Body 槽没有 form 轴(第一实参永远是契约)。
    expect(create.slots[0]).not.toHaveProperty("form");

    const rename = contractOf(result, "PUT", "/users/:id");
    expect(rename.slots).toMatchObject([
      { slot: "body", key: "name" },
      { slot: "param", key: "id", form: "contract" },
    ]);

    const tags = contractOf(result, "GET", "/users/tags");
    expect(tags.slots).toMatchObject([
      {
        slot: "query",
        key: "tag",
        form: "single",
        table: {
          root: {
            kind: "array",
            element: { kind: "scalar", scalar: "string", nullable: false },
            nullable: false,
          },
        },
      },
    ]);
  });

  test("the response side keeps Response/Promise<void> as passthrough and expands annotated DTOs", async () => {
    const result = await compileSlotsOrThrow(sources);

    expect(contractOf(result, "GET", "/users/raw").response).toEqual({ kind: "passthrough" });
    expect(contractOf(result, "GET", "/users/nothing").response).toEqual({ kind: "passthrough" });
    expect(contractOf(result, "GET", "/users/dto").response).toMatchObject({ kind: "table" });

    const routesModule = generatedContent(result, "routes.ts");
    expect(routesModule).toContain("encode: webEncode");
  });

  test("the generated invoke wires bare slots from context and data slots through typed-edge casts", async () => {
    const result = await compileSlotsOrThrow(sources);

    const routesModule = generatedContent(result, "routes.ts");
    expect(routesModule).toContain("slots[0] as bigint");
    expect(routesModule).toContain("slots[1] as number | undefined");
    expect(routesModule).toContain("slots[2] as string | undefined");
    expect(routesModule).toContain("context, context.request, context.responseHeaders)");
    // 第四档投影在 invoke 处展开:解码产物按整契约,实参按键取。
    expect(routesModule).toContain('["name"]');
    expect(routesModule).toContain('["id"]');
  });
});

describe("slot hard errors", () => {
  function controller(handlerLines: readonly string[], routePath = '"/users/:id"'): string {
    return [
      controllerImports,
      "@Controller()",
      "export class UsersController {",
      `  @Get(${routePath})`,
      ...handlerLines.map((line) => `  ${line}`),
      "}",
    ].join("\n");
  }

  test("a bare string key is INVALID_SLOT_KEY", async () => {
    const result = await compileSlots({
      "users-controller.ts": controller(["show(_id: Param<string>): void {}"]),
    });

    expect(expectFailure(result).diagnostics.map((item) => item.code)).toEqual([
      "INVALID_SLOT_KEY",
    ]);
  });

  test("a literal union key is INVALID_SLOT_KEY", async () => {
    const result = await compileSlots({
      "users-controller.ts": controller(['show(_id: Param<"id" | "name">): void {}']),
    });

    expect(expectFailure(result).diagnostics.map((item) => item.code)).toEqual([
      "INVALID_SLOT_KEY",
    ]);
  });

  test("a bare scalar contract is INVALID_SLOT_CONTRACT with a machine-applicable rewrite", async () => {
    // 建议的键名取自参数名,夹具用无前缀的 id 钉住改写文本。
    const result = await compileSlots({
      "users-controller.ts": controller(["show(id: Param<bigint>): void {}"]),
    });

    const failure = expectFailure(result);
    expect(failure.diagnostics.map((item) => item.code)).toEqual(["INVALID_SLOT_CONTRACT"]);
    expect(failure.diagnostics[0]?.suggestions).toMatchObject([
      { replacement: 'Param<"id", bigint>', applicability: "machine-applicable" },
    ]);
  });

  test("two contracts on one slot are CONFLICTING_SLOT_CONTRACT", async () => {
    const result = await compileSlots({
      "contracts.ts": [
        "export interface A {",
        "  id: bigint;",
        "}",
        "export interface B {",
        "  id: string;",
        "}",
      ].join("\n"),
      "users-controller.ts": [
        controllerImports,
        'import type { A, B } from "@/contracts";',
        "@Controller()",
        "export class UsersController {",
        '  @Get("/users/:id")',
        "  show(_a: Param<A>, _b: Param<B>): void {}",
        "}",
      ].join("\n"),
    });

    expect(expectFailure(result).diagnostics.map((item) => item.code)).toEqual([
      "CONFLICTING_SLOT_CONTRACT",
    ]);
  });

  test("the same single key bound twice is DUPLICATE_SLOT_BINDING", async () => {
    const result = await compileSlots({
      "users-controller.ts": controller([
        'show(_a: Param<"id", bigint>, _b: Param<"id", bigint>): void {}',
      ]),
    });

    expect(expectFailure(result).diagnostics.map((item) => item.code)).toEqual([
      "DUPLICATE_SLOT_BINDING",
    ]);
  });

  test("a param key the path never declares is UNKNOWN_PATH_PARAMETER", async () => {
    const result = await compileSlots({
      "users-controller.ts": controller(['show(_other: Param<"other", bigint>): void {}']),
    });

    expect(expectFailure(result).diagnostics.map((item) => item.code)).toEqual([
      "UNKNOWN_PATH_PARAMETER",
    ]);
  });

  test("a destructured parameter is INVALID_SLOT_ANNOTATION", async () => {
    const result = await compileSlots({
      "users-controller.ts": controller([
        "show({ id }: { id: string }): void {",
        "  void id;",
        "}",
      ]),
    });

    expect(expectFailure(result).diagnostics.map((item) => item.code)).toEqual([
      "INVALID_SLOT_ANNOTATION",
    ]);
  });
});

// schema typeof 追溯:手写 ~standard 夹具(真 zod 不引入),内联/别名/包裹/数组各形态 +
// 泛型别名降级,一次编译多路由铺开;负向单独编译。
describe("schema tracing", () => {
  const schemaSources = {
    "schemas.ts": [
      "export interface ItSchema<O> {",
      '  readonly "~standard": {',
      "    readonly version: 1;",
      '    readonly vendor: "it";',
      "    readonly validate: (",
      "      value: unknown,",
      "    ) => { value: O } | { issues: readonly { message: string }[] };",
      "  };",
      "}",
      "function schema<O>(): ItSchema<O> {",
      "  return {",
      '    "~standard": {',
      "      version: 1,",
      '      vendor: "it",',
      "      // 夹具只关心类型面,校验行为不在本 IT 的断言范围 // justified: 测试夹具",
      "      validate: (value) => ({ value: value as O }),",
      "    },",
      "  };",
      "}",
      "export type InferOutput<T> = T extends ItSchema<infer O> ? O : never;",
      "export const createUserSchema = schema<{ name: string; age: number }>();",
      "export const tagSchema = schema<{ label: string }>();",
      "// 输入/输出两侧分离的夹具(#310):模拟 zod .default()(输出恒有值、输入可缺省,",
      "// coerce 输入侧是 unknown)与反向 transform(输入必填、输出可缺省)。",
      "export interface ItSchemaIO<I, O> {",
      '  readonly "~standard": {',
      "    readonly version: 1;",
      '    readonly vendor: "it";',
      "    readonly types: { readonly input: I; readonly output: O } | undefined;",
      "    readonly validate: (",
      "      value: unknown,",
      "    ) => { value: O } | { issues: readonly { message: string }[] };",
      "  };",
      "}",
      "function schemaIO<I, O>(): ItSchemaIO<I, O> {",
      "  return {",
      '    "~standard": {',
      "      version: 1,",
      '      vendor: "it",',
      "      types: undefined,",
      "      // 夹具只关心类型面,校验行为不在本 IT 的断言范围 // justified: 测试夹具",
      "      validate: (value) => ({ value: value as O }),",
      "    },",
      "  };",
      "}",
      "export type InferIO<T> = T extends ItSchemaIO<infer _I, infer O> ? O : never;",
      "export const searchQuerySchema = schemaIO<",
      "  { page?: unknown; mode: string },",
      "  { page: number; mode?: string }",
      ">();",
    ].join("\n"),
    "aliases.ts": [
      'import { type InferOutput, createUserSchema } from "@/schemas";',
      "// 非泛型别名:追溯要跟到右侧,且 typeof 的值在本模块解析。",
      "export type CreateUser = InferOutput<typeof createUserSchema>;",
      "// 泛型别名不追溯(rhs 不登记),使用处合法降级为按类型生成解码器。",
      "export type ViaGeneric<T> = InferOutput<typeof createUserSchema>;",
      "// 命名别名会被提升成 definition:wire 合并后引用根内联、孤儿定义按可达性剪掉。",
      'import { type InferIO, searchQuerySchema } from "@/schemas";',
      "export type SearchQueryAlias = InferIO<typeof searchQuerySchema>;",
    ].join("\n"),
    "users-controller.ts": [
      controllerImports,
      'import type { CreateUser, SearchQueryAlias, ViaGeneric } from "@/aliases";',
      'import { type InferIO, type InferOutput, createUserSchema, searchQuerySchema, tagSchema } from "@/schemas";',
      "@Controller()",
      "export class UsersController {",
      '  @Get("/search")',
      "  search(_query: Query<InferIO<typeof searchQuerySchema>>): void {}",
      "",
      '  @Get("/search-aliased")',
      "  searchAliased(_query: Query<SearchQueryAlias>): void {}",
      "",
      '  @Post("/inline")',
      "  inline(_body: Body<InferOutput<typeof createUserSchema>>): void {}",
      "",
      '  @Post("/aliased")',
      "  aliased(_body: Body<CreateUser>): void {}",
      "",
      '  @Post("/wrapped")',
      '  wrapped(_body: Body<Omit<InferOutput<typeof createUserSchema>, "age">>): void {}',
      "",
      '  @Post("/list")',
      "  list(_body: Body<InferOutput<typeof tagSchema>[]>): void {}",
      "",
      '  @Post("/generic")',
      "  generic(_body: Body<ViaGeneric<unknown>>): void {}",
      "}",
    ].join("\n"),
  };

  test("inline, aliased, wrapped and array forms all trace to the schema with its vendor", async () => {
    const result = await compileSlotsOrThrow(schemaSources);

    const schemaSource = {
      source: "schema",
      schema: { moduleSpecifier: "../../src/schemas.js", exportName: "createUserSchema" },
      vendor: "it",
    };
    expect(contractOf(result, "POST", "/inline").slots[0]).toMatchObject({
      slot: "body",
      source: schemaSource,
    });
    expect(contractOf(result, "POST", "/aliased").slots[0]).toMatchObject({
      source: schemaSource,
    });
    expect(contractOf(result, "POST", "/wrapped").slots[0]).toMatchObject({
      source: schemaSource,
    });
    expect(contractOf(result, "POST", "/list").slots[0]).toMatchObject({
      source: {
        source: "schema",
        schema: { moduleSpecifier: "../../src/schemas.js", exportName: "tagSchema" },
        vendor: "it",
      },
    });
    // routes.ts 按坐标重新 import 用户 schema,解码交给它。
    const routesModule = generatedContent(result, "routes.ts");
    expect(routesModule).toContain(
      'import { createUserSchema as webSchema0 } from "../../src/schemas.js";',
    );
    expect(routesModule).toContain('{ slot: "body", schema: webSchema0 },');
  });

  test("a schema slot merges input-side optionality into the manifest table only", async () => {
    const result = await compileSlotsOrThrow(schemaSources);

    // routes.json 落线上侧:page 输出侧必填但输入侧可缺省(.default() 形态)→ optional;
    // mode 输出侧可缺省但输入侧必填(transform 形态)→ 必填。
    expect(contractOf(result, "GET", "/search").slots[0]).toMatchObject({
      slot: "query",
      form: "contract",
      source: {
        source: "schema",
        schema: { moduleSpecifier: "../../src/schemas.js", exportName: "searchQuerySchema" },
        vendor: "it",
      },
      table: {
        root: {
          kind: "object",
          nullable: false,
          fields: [
            {
              name: "mode",
              optional: false,
              shape: { kind: "scalar", scalar: "string", nullable: false },
            },
            {
              name: "page",
              optional: true,
              shape: { kind: "scalar", scalar: "number", nullable: false },
            },
          ],
        },
      },
    });
    // typed-edge 不动:routes.ts 的 invoke 断言仍是 handler 侧(schema 输出)的形状。
    const routesModule = generatedContent(result, "routes.ts");
    expect(routesModule).toContain('slots[0] as { "mode"?: string; "page": number }');
  });

  test("a named-alias schema slot merges input-side optionality like the inline form", async () => {
    const result = await compileSlotsOrThrow(schemaSources);

    // 条件类型别名(InferIO<typeof x>)不被提升为 definition,根保持内联对象——wire 合并
    // 与内联写法同路径。引用根的内联+可达性剪枝是 wireTableOf 的发射不变量防御,当前
    // 别名形态不触发。
    const slot = contractOf(result, "GET", "/search-aliased").slots[0] as {
      readonly table: {
        readonly root: Record<string, unknown>;
        readonly definitions: Record<string, unknown>;
      };
    };
    expect(slot.table.root).toMatchObject({
      kind: "object",
      fields: [
        { name: "mode", optional: false },
        { name: "page", optional: true },
      ],
    });
    expect(slot.table.definitions).toEqual({});
  });

  test("a generic alias is not followed and falls back to a type-generated decoder", async () => {
    const result = await compileSlotsOrThrow(schemaSources);

    expect(contractOf(result, "POST", "/generic").slots[0]).toMatchObject({
      slot: "body",
      source: { source: "type" },
    });
  });

  test("a traced value that is not exported is INVALID_SLOT_SCHEMA", async () => {
    const result = await compileSlots({
      "schemas.ts": [
        'import type { ItSchema } from "@/support";',
        "export type { ItSchema };",
      ].join("\n"),
      "support.ts": [
        "export interface ItSchema<O> {",
        '  readonly "~standard": { readonly version: 1; readonly vendor: "it"; readonly validate: (value: unknown) => { value: O } };',
        "}",
        "export type InferOutput<T> = T extends ItSchema<infer O> ? O : never;",
        "const hidden: ItSchema<{ name: string }> = {",
        '  "~standard": {',
        "    version: 1,",
        '    vendor: "it",',
        "    // 同上,夹具只关心类型面 // justified: 测试夹具",
        "    validate: (value) => ({ value: value as { name: string } }),",
        "  },",
        "};",
        "export const shapes = { hidden };",
      ].join("\n"),
      "users-controller.ts": [
        controllerImports,
        'import type { InferOutput } from "@/support";',
        'import { shapes } from "@/support";',
        "@Controller()",
        "export class UsersController {",
        '  @Post("/users")',
        "  create(_body: Body<InferOutput<typeof shapes.hidden>>): void {}",
        "}",
      ].join("\n"),
    });

    expect(expectFailure(result).diagnostics.map((item) => item.code)).toEqual([
      "INVALID_SLOT_SCHEMA",
    ]);
  });

  test("a traced value without ~standard is INVALID_SLOT_SCHEMA", async () => {
    const result = await compileSlots({
      "shapes.ts": [
        "export const userShape = { name: String };",
        "export type Named<T> = T extends { name: unknown } ? { name: string } : never;",
      ].join("\n"),
      "users-controller.ts": [
        controllerImports,
        'import { type Named, userShape } from "@/shapes";',
        "@Controller()",
        "export class UsersController {",
        '  @Post("/users")',
        "  create(_body: Body<Named<typeof userShape>>): void {}",
        "}",
      ].join("\n"),
    });

    expect(expectFailure(result).diagnostics.map((item) => item.code)).toEqual([
      "INVALID_SLOT_SCHEMA",
    ]);
  });
});

// checker 进程经济学(linux only,/proc 扫描沿用 it/checker-session.spec.ts 的零件):
// lease 懒 spawn 语义穿透到 compile 级——无数据槽的编译零查询零进程;kill 后的下一轮编译
// 收口成 TYPE_CHECKER_UNAVAILABLE failure,再下一轮会话自动重建。
describe.runIf(process.platform === "linux")("checker process economics", () => {
  function tsgoChildProcessIds(): readonly number[] {
    const children: number[] = [];
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) {
        continue;
      }
      try {
        const stat = readFileSync(path.join("/proc", entry, "stat"), "utf8");
        const closeParen = stat.lastIndexOf(")");
        const command = stat.slice(stat.indexOf("(") + 1, closeParen);
        const parentId = Number(stat.slice(closeParen + 2).split(" ")[1]);
        if (command === "tsc" && parentId === process.pid) {
          children.push(Number(entry));
        }
      } catch {
        // 进程在扫描间隙退出,跳过。
      }
    }
    return children;
  }

  async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error("Condition not reached in time");
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
  }

  test("a project without data slots compiles without spawning tsgo", async () => {
    const project = await preparedProject({
      "users-controller.ts": [
        controllerImports,
        "@Controller()",
        "export class UsersController {",
        '  @Get("/users")',
        "  list(_context: RequestContext): Response {",
        '    return new Response("ok");',
        "  }",
        "}",
      ].join("\n"),
    });
    const compiler = createCompiler();
    const resolution = await compiler.resolveProject({ projectDirectory: project.projectRoot });
    if (resolution.status === "failure") {
      throw new Error(JSON.stringify(resolution.diagnostics));
    }
    const before = tsgoChildProcessIds().length;

    const result = await compiler.compile({ project: resolution.project });

    expect(result.status).toBe("success");
    expect(tsgoChildProcessIds().length).toBe(before);
    compiler.close();
  });

  test("a killed tsgo fails the next compilation and the one after rebuilds", async () => {
    const project = await preparedProject({
      "users-controller.ts": [
        controllerImports,
        "@Controller()",
        "export class UsersController {",
        '  @Get("/users/:id")',
        '  show(_id: Param<"id", bigint>): void {}',
        "}",
      ].join("\n"),
    });
    const compiler = createCompiler();
    const resolution = await compiler.resolveProject({ projectDirectory: project.projectRoot });
    if (resolution.status === "failure") {
      throw new Error(JSON.stringify(resolution.diagnostics));
    }
    const known = new Set(tsgoChildProcessIds());

    const first = await compiler.compile({ project: resolution.project });
    expect(first.status).toBe("success");
    const spawned = tsgoChildProcessIds().filter((processId) => !known.has(processId));
    expect(spawned).toHaveLength(1);
    const childId = spawned[0];
    if (childId === undefined) {
      throw new Error("expected a tsgo child");
    }

    process.kill(childId, "SIGKILL");
    await waitFor(() => {
      try {
        process.kill(childId, 0);
        return false;
      } catch {
        return true;
      }
    });

    const second = await compiler.compile({ project: resolution.project });
    const failure = expectFailure(second);
    expect(failure.diagnostics.map((item) => item.code)).toContain("TYPE_CHECKER_UNAVAILABLE");

    const third = await compiler.compile({ project: resolution.project });
    expect(third.status).toBe("success");
    compiler.close();
  });
});
