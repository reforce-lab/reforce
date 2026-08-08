import {
  createTemporaryProject,
  type ProjectTree,
  type TemporaryProject,
} from "@reforce/tooling-testing";
import { afterEach, describe, expect, test } from "vitest";
import { type CompileResult, createCompiler } from "@/index";
import { applicationTsconfig } from "./support/project";

// 继承来的构造器（#350）：派生类不写构造器时 TypeScript 补的是
// `constructor(...args) { super(...args) }`，实参原样转发给最近一个自己写了构造器的祖先。
// 依赖边必须按那个祖先的参数表建，否则生成物 emit `new Foo()`、基类字段被静默赋 undefined。

const temporaryProjects: TemporaryProject[] = [];

afterEach(async () => {
  await Promise.all(temporaryProjects.splice(0).map((project) => project.cleanup()));
});

async function compileTree(tree: ProjectTree): Promise<CompileResult> {
  const input = await createTemporaryProject({ "tsconfig.json": applicationTsconfig(), ...tree });
  temporaryProjects.push(input);
  const compiler = createCompiler();
  const resolution = await compiler.resolveProject({ projectDirectory: input.projectRoot });
  if (resolution.status === "failure") {
    throw new Error(JSON.stringify(resolution.diagnostics));
  }
  return compiler.compile({ project: resolution.project });
}

function compileSource(source: string): Promise<CompileResult> {
  return compileTree({ src: { "application.ts": source } });
}

// 单条 registration 的 create 表达式：断言依赖实参形状，不去猜 beanTarget 的编号顺序。
function createExpressionOf(beans: string, id: string): string {
  const marker = `id: ${JSON.stringify(id)},`;
  const registration = beans.indexOf(marker);
  if (registration < 0) {
    throw new Error(`No registration for ${id}`);
  }
  const prefix = "create: (resolver) => ";
  const start = beans.indexOf(prefix, registration);
  return beans.slice(start + prefix.length, beans.indexOf("\n", start));
}

function beansOf(result: CompileResult): string {
  if (result.status !== "success") {
    throw new Error(JSON.stringify(result.diagnostics));
  }
  const beans = result.files.find((file) => file.path === "beans.ts")?.content;
  if (beans === undefined) {
    throw new Error("beans.ts missing from the generated files");
  }
  return beans;
}

function diagnosticMessages(result: CompileResult): readonly string[] {
  return result.diagnostics.map((item) => item.message);
}

const repositoryLines = [
  'import { Injectable } from "@reforce/core";',
  "export interface GreetingPort { value(): string; }",
  "@Injectable()",
  'export class MessageRepository implements GreetingPort { value(): string { return "hello"; } }',
];

const singleLevelApplication = [
  ...repositoryLines,
  "export abstract class BaseGreetingService {",
  "  constructor(protected readonly repository: GreetingPort) {}",
  "  greet(): string { return this.repository.value(); }",
  "}",
  "@Injectable()",
  "export class GreetingService extends BaseGreetingService {}",
  "",
].join("\n");

describe("inherited constructor dependencies", () => {
  test("compiles without diagnostics when an Injectable inherits a parameterized base constructor", async () => {
    const result = await compileSource(singleLevelApplication);

    expect(diagnosticMessages(result)).toEqual([]);
  });

  test("resolves the inherited base constructor parameter into a dependency edge", async () => {
    const result = await compileSource(singleLevelApplication);

    const create = createExpressionOf(beansOf(result), "src/application.ts#GreetingService");
    expect(create).toMatch(/^new \w+\(resolver\.resolve<\w+>\(0\)\),$/u);
  });

  test("orders the construction so the inherited dependency is built first", async () => {
    const result = await compileSource(singleLevelApplication);

    // 依赖表为空时 GreetingService 排在前面（本次修复前的产物就是那样）。
    const beans = beansOf(result);
    expect(beans).toMatch(
      /"constructionOrder": \[\s*"src\/application\.ts#MessageRepository",\s*"src\/application\.ts#GreetingService"/u,
    );
  });

  test("walks past intermediate classes that declare no constructor of their own", async () => {
    const result = await compileSource(
      [
        ...repositoryLines,
        "export abstract class RootService {",
        "  constructor(protected readonly repository: GreetingPort) {}",
        "}",
        "export abstract class MiddleService extends RootService {}",
        "@Injectable()",
        "export class LeafService extends MiddleService {}",
        "",
      ].join("\n"),
    );

    expect(diagnosticMessages(result)).toEqual([]);
    expect(createExpressionOf(beansOf(result), "src/application.ts#LeafService")).toMatch(
      /^new \w+\(resolver\.resolve<\w+>\(0\)\),$/u,
    );
  });

  test("resolves a base constructor parameter type in the base module scope", async () => {
    // 基类在另一个文件里 import 契约：参数类型只在基类模块的作用域里有名字，按 Injectable
    // 所在模块解析会解不出来。
    const result = await compileTree({
      src: {
        "port.ts": "export interface GreetingPort { value(): string; }\n",
        "repository.ts": [
          'import { Injectable } from "@reforce/core";',
          'import type { GreetingPort } from "./port";',
          "@Injectable()",
          'export class MessageRepository implements GreetingPort { value(): string { return "hi"; } }',
          "",
        ].join("\n"),
        "base.ts": [
          'import type { GreetingPort } from "./port";',
          "export abstract class BaseGreetingService {",
          "  constructor(protected readonly repository: GreetingPort) {}",
          "}",
          "",
        ].join("\n"),
        "application.ts": [
          'import { Injectable } from "@reforce/core";',
          'import { BaseGreetingService } from "./base";',
          "@Injectable()",
          "export class GreetingService extends BaseGreetingService {}",
          "",
        ].join("\n"),
      },
    });

    expect(diagnosticMessages(result)).toEqual([]);
    expect(createExpressionOf(beansOf(result), "src/application.ts#GreetingService")).toMatch(
      /^new \w+\(resolver\.resolve<\w+>\(0\)\),$/u,
    );
  });

  test("reads an inherited constructor out of a base class published only as a declaration file", async () => {
    const result = await compileTree({
      node_modules: {
        "@acme": {
          base: {
            "package.json": `${JSON.stringify({
              name: "@acme/base",
              version: "1.0.0",
              types: "./index.d.ts",
              exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
            })}\n`,
            "index.d.ts": [
              "export interface GreetingPort { value(): string; }",
              "export declare abstract class BaseGreetingService {",
              "  protected readonly repository: GreetingPort;",
              "  constructor(repository: GreetingPort);",
              "}",
              "",
            ].join("\n"),
            "index.js": "export class BaseGreetingService {}\n",
          },
        },
      },
      src: {
        "application.ts": [
          'import { Injectable } from "@reforce/core";',
          'import { BaseGreetingService, type GreetingPort } from "@acme/base";',
          "@Injectable()",
          'export class MessageRepository implements GreetingPort { value(): string { return "hi"; } }',
          "@Injectable()",
          "export class GreetingService extends BaseGreetingService {}",
          "",
        ].join("\n"),
      },
    });

    expect(diagnosticMessages(result)).toEqual([]);
    // 契约来自未注册为 starter 的包，meta 户口表里查不到 type-only import 的 specifier，
    // 所以这条边没有类型实参——那是既有的 typed-edge 规则，与本次回溯无关。
    expect(createExpressionOf(beansOf(result), "src/application.ts#GreetingService")).toMatch(
      /^new \w+\(resolver\.resolve\(0\)\),$/u,
    );
  });

  test("keeps the class's own constructor when it declares one", async () => {
    const result = await compileSource(
      [
        ...repositoryLines,
        "export abstract class BaseGreetingService {",
        "  constructor(protected readonly repository: GreetingPort) {}",
        "}",
        "@Injectable()",
        "export class GreetingService extends BaseGreetingService {",
        '  constructor() { super({ value: () => "own" }); }',
        "}",
        "",
      ].join("\n"),
    );

    expect(diagnosticMessages(result)).toEqual([]);
    expect(createExpressionOf(beansOf(result), "src/application.ts#GreetingService")).toMatch(
      /^new \w+\(\),$/u,
    );
  });

  test("emits a zero-argument instantiation when the whole chain declares no constructor", async () => {
    const result = await compileSource(
      [
        'import { Injectable } from "@reforce/core";',
        'export abstract class BaseGreetingService { greet(): string { return "hello"; } }',
        "@Injectable()",
        "export class GreetingService extends BaseGreetingService {}",
        "",
      ].join("\n"),
    );

    expect(diagnosticMessages(result)).toEqual([]);
    expect(createExpressionOf(beansOf(result), "src/application.ts#GreetingService")).toMatch(
      /^new \w+\(\),$/u,
    );
  });

  test("carries the Lazy wrapper declared on an inherited constructor parameter", async () => {
    const result = await compileSource(
      [
        'import { Injectable, type Lazy } from "@reforce/core";',
        "export interface GreetingPort { value(): string; }",
        "@Injectable()",
        'export class MessageRepository implements GreetingPort { value(): string { return "hi"; } }',
        "export abstract class BaseGreetingService {",
        "  constructor(protected readonly repository: Lazy<GreetingPort>) {}",
        "}",
        "@Injectable()",
        "export class GreetingService extends BaseGreetingService {}",
        "",
      ].join("\n"),
    );

    expect(diagnosticMessages(result)).toEqual([]);
    expect(createExpressionOf(beansOf(result), "src/application.ts#GreetingService")).toMatch(
      /^new \w+\(resolver\.lazy<\w+>\(0\)\),$/u,
    );
  });

  test("instantiates through a protected base constructor", async () => {
    const result = await compileSource(
      [
        ...repositoryLines,
        "export abstract class BaseGreetingService {",
        "  protected constructor(protected readonly repository: GreetingPort) {}",
        "}",
        "@Injectable()",
        "export class GreetingService extends BaseGreetingService {}",
        "",
      ].join("\n"),
    );

    expect(diagnosticMessages(result)).toEqual([]);
    expect(createExpressionOf(beansOf(result), "src/application.ts#GreetingService")).toMatch(
      /^new \w+\(resolver\.resolve<\w+>\(0\)\),$/u,
    );
  });

  test("still rejects a protected constructor declared on the Injectable itself", async () => {
    const result = await compileSource(
      [
        ...repositoryLines,
        "@Injectable()",
        "export class GreetingService {",
        "  protected constructor(readonly repository: GreetingPort) {}",
        "}",
        "",
      ].join("\n"),
    );

    expect(diagnosticMessages(result)).toContain(
      "An Injectable must have zero or one public implementation constructor and no overload signatures.",
    );
  });

  test("reports a circular extends chain instead of silently emitting an empty dependency table", async () => {
    const result = await compileSource(
      [
        'import { Injectable } from "@reforce/core";',
        "export class Left extends Right {}",
        "export class Right extends Left {}",
        "@Injectable()",
        "export class GreetingService extends Left {}",
        "",
      ].join("\n"),
    );

    expect(diagnosticMessages(result)).toContain(
      "Cannot determine the constructor of GreetingService: its extends chain is circular or deeper than 16.",
    );
  });

  test("leaves the dependency table empty when the base class is a mixin call", async () => {
    // extends f(...) 跟不出静态类身份，继承链在此断开——这条断链由生成物进类型检查兜底，
    // 不在分析层硬错，否则一切 mixin 写法都编译不过。
    const result = await compileSource(
      [
        'import { Injectable } from "@reforce/core";',
        "export function withGreeting<T extends new (...args: never[]) => object>(base: T) {",
        "  return class extends base {};",
        "}",
        "export class Empty {}",
        "@Injectable()",
        "export class GreetingService extends withGreeting(Empty) {}",
        "",
      ].join("\n"),
    );

    expect(createExpressionOf(beansOf(result), "src/application.ts#GreetingService")).toMatch(
      /^new \w+\(\),$/u,
    );
  });
});
