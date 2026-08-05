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
  applicationTsconfig,
  type CompileSuccess,
  linkApplicationPackages,
} from "./support/project";

// request scope IT（ADR 0006 W7，#142 / #151）：scope 是编译期属性——@RequestScoped() /
// defineBean scope: "request" 声明请求作用域；singleton→request 裸边是编译期硬错，唯一合法通道是
// Current<T> 句柄；请求构造顺序是编译期算好的第二组计划（requestConstructionOrder），生成物
// schemaVersion 升 4。交叉形态（集合成员、Current<T[]>、Lazy<Current<T>> 等）从紧硬错。

type FailureResult = Extract<CompileResult, { readonly status: "failure" }>;

const nodeExecutable = await resolveNodeExecutable();
const temporaryProjects: TemporaryProject[] = [];

afterAll(async () => {
  await Promise.all(temporaryProjects.splice(0).map((project) => project.cleanup()));
});

async function compileTree(tree: ProjectTree): Promise<{
  readonly project: TemporaryProject;
  readonly result: CompileResult;
}> {
  const project = await createTemporaryProject(tree);
  temporaryProjects.push(project);
  const compiler = createCompiler();
  const resolution = await compiler.resolveProject({ projectDirectory: project.projectRoot });
  if (resolution.status === "failure") {
    throw new Error(JSON.stringify(resolution.diagnostics));
  }
  return { project, result: await compiler.compile({ project: resolution.project }) };
}

async function compileSource(source: string): Promise<CompileResult> {
  const { result } = await compileTree({
    "tsconfig.json": applicationTsconfig(),
    src: { "application.ts": source },
  });
  return result;
}

async function compileSourceOrThrow(source: string): Promise<CompileSuccess> {
  const result = await compileSource(source);
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

interface ManifestDependency {
  readonly parameterIndex: number;
  readonly mode: string;
  readonly targetId?: string;
  readonly source?: unknown;
}

interface ManifestBean {
  readonly id: string;
  readonly scope: string;
  readonly dependencies: readonly ManifestDependency[];
}

interface Manifest {
  readonly schemaVersion: number;
  readonly beans: readonly ManifestBean[];
  readonly plans: {
    readonly constructionOrder: readonly string[];
    readonly requestConstructionOrder: readonly string[];
    readonly startActionOrder: readonly string[];
    readonly cleanupActionOrder: readonly string[];
  };
}

function manifestOf(result: CompileSuccess): Manifest {
  return JSON.parse(generatedContent(result, "manifest.json"));
}

function manifestBean(result: CompileSuccess, id: string): ManifestBean {
  const bean = manifestOf(result).beans.find((candidate) => candidate.id === id);
  if (bean === undefined) {
    throw new Error(`Missing manifest Bean ${id}`);
  }
  return bean;
}

describe("request scope declarations", () => {
  test("@RequestScoped and defineBean scope request mark Beans as request scope in the manifest", async () => {
    const result = await compileSourceOrThrow(
      [
        'import { defineBean, Injectable, RequestScoped } from "@reforce/context";',
        "export class Trace { constructor(readonly label: string) {} }",
        "@Injectable() @RequestScoped() export class Session {}",
        "@Injectable() export class Clock {}",
        'export const requestTrace = defineBean<Trace>({ scope: "request", create: async () => new Trace("trace") });',
      ].join("\n"),
    );

    expect(manifestOf(result).schemaVersion).toBe(4);
    expect(manifestBean(result, "src/application.ts#Session").scope).toBe("request");
    expect(manifestBean(result, "src/application.ts#requestTrace").scope).toBe("request");
    expect(manifestBean(result, "src/application.ts#Clock").scope).toBe("singleton");
  });

  test("request Beans construct through the second plan, never the singleton plan", async () => {
    const result = await compileSourceOrThrow(
      [
        'import { Injectable, RequestScoped } from "@reforce/context";',
        "@Injectable() export class Clock {}",
        "@Injectable() @RequestScoped() export class Session {}",
      ].join("\n"),
    );

    expect(manifestOf(result).plans.constructionOrder).toEqual(["src/application.ts#Clock"]);
    expect(manifestOf(result).plans.requestConstructionOrder).toEqual([
      "src/application.ts#Session",
    ]);
  });

  test("the request plan orders request Beans dependency-first", async () => {
    const result = await compileSourceOrThrow(
      [
        'import { Injectable, RequestScoped } from "@reforce/context";',
        // beanId 序 Derived < Root；依赖序必须推翻它。
        "@Injectable() @RequestScoped() export class Root {}",
        "@Injectable() @RequestScoped() export class Derived {",
        "  constructor(readonly root: Root) {}",
        "}",
      ].join("\n"),
    );

    expect(manifestOf(result).plans.requestConstructionOrder).toEqual([
      "src/application.ts#Root",
      "src/application.ts#Derived",
    ]);
  });

  test("the emitted definition carries scope fields under schemaVersion 4", async () => {
    const result = await compileSourceOrThrow(
      [
        'import { Injectable, RequestScoped } from "@reforce/context";',
        "@Injectable() @RequestScoped() export class Session {}",
      ].join("\n"),
    );

    const beans = generatedContent(result, "beans.ts");
    expect(beans).toContain("schemaVersion: 4,");
    expect(beans).toContain('scope: "request",');
  });

  test("@RequestScoped without @Injectable is rejected", async () => {
    const failure = expectFailure(
      await compileSource(
        [
          'import { RequestScoped } from "@reforce/context";',
          "@RequestScoped() export class Plain {}",
        ].join("\n"),
      ),
    );

    expect(failure.diagnostics.map((item) => item.code)).toEqual(["INVALID_DECORATOR_USAGE"]);
  });

  test("@RequestScoped must appear exactly once without arguments", async () => {
    const failure = expectFailure(
      await compileSource(
        [
          'import { Injectable, RequestScoped } from "@reforce/context";',
          '@Injectable() @RequestScoped("web") export class WithArgument {}',
          "@Injectable() @RequestScoped() @RequestScoped() export class Twice {}",
        ].join("\n"),
      ),
    );

    expect(failure.diagnostics.map((item) => item.code)).toEqual([
      "INVALID_DECORATOR_USAGE",
      "INVALID_DECORATOR_USAGE",
    ]);
  });

  test("@Order cannot mark a request-scoped Bean", async () => {
    const failure = expectFailure(
      await compileSource(
        [
          'import { Injectable, Order, RequestScoped } from "@reforce/context";',
          "@Injectable() @RequestScoped() @Order(1) export class Session {}",
        ].join("\n"),
      ),
    );

    expect(failure.diagnostics.map((item) => item.code)).toEqual(["INVALID_DECORATOR_USAGE"]);
  });

  test("a request-scoped class cannot declare context lifecycle hooks", async () => {
    const failure = expectFailure(
      await compileSource(
        [
          'import { Injectable, type OnContextStart, RequestScoped } from "@reforce/context";',
          "@Injectable() @RequestScoped() export class Session implements OnContextStart {",
          "  onContextStart(): void {}",
          "}",
        ].join("\n"),
      ),
    );

    expect(failure.diagnostics.map((item) => item.code)).toEqual(["INVALID_LIFECYCLE_DECLARATION"]);
  });

  test("defineBean only accepts the literal request scope", async () => {
    const failure = expectFailure(
      await compileSource(
        [
          'import { defineBean } from "@reforce/context";',
          "export class Trace {}",
          'export const trace = defineBean<Trace>({ scope: "singleton", create: () => new Trace() });',
        ].join("\n"),
      ),
    );

    expect(failure.diagnostics.map((item) => item.code)).toEqual(["INVALID_DEFINE_BEAN"]);
  });

  test("an async create still requires the request scope", async () => {
    const failure = expectFailure(
      await compileSource(
        [
          'import { defineBean } from "@reforce/context";',
          "export class Trace {}",
          "export const trace = defineBean<Trace>({ create: async () => new Trace() });",
        ].join("\n"),
      ),
    );

    expect(failure.diagnostics.map((item) => item.code)).toEqual(["INVALID_DEFINE_BEAN"]);
  });

  test("a request-scoped factory cannot declare dispose", async () => {
    const failure = expectFailure(
      await compileSource(
        [
          'import { defineBean } from "@reforce/context";',
          "export class Trace {}",
          "export const trace = defineBean<Trace>({",
          '  scope: "request",',
          "  create: () => new Trace(),",
          "  dispose: (instance) => {},",
          "});",
        ].join("\n"),
      ),
    );

    expect(failure.diagnostics.map((item) => item.code)).toEqual(["INVALID_DEFINE_BEAN"]);
  });
});

describe("cross-scope edges", () => {
  const sessionAndHolder = (holderParameter: string): string =>
    [
      'import { type Current, Injectable, type Lazy, RequestScoped } from "@reforce/context";',
      "@Injectable() @RequestScoped() export class Session {}",
      "@Injectable() export class Holder {",
      `  constructor(readonly session: ${holderParameter}) {}`,
      "}",
    ].join("\n");

  test("a bare singleton edge onto a request Bean is a compile error pointing to Current", async () => {
    const failure = expectFailure(await compileSource(sessionAndHolder("Session")));

    const error = failure.diagnostics.find(
      (item) => item.code === "INVALID_REQUEST_SCOPE_DEPENDENCY",
    );
    expect(failure.diagnostics.map((item) => item.code)).toEqual([
      "INVALID_REQUEST_SCOPE_DEPENDENCY",
    ]);
    expect(error?.help).toContain("Current");
    const relatedText = (error?.related ?? []).map((item) => item.message).join("\n");
    expect(relatedText).toContain("src/application.ts#Holder");
    expect(relatedText).toContain("src/application.ts#Session");
  });

  test("a Lazy singleton edge onto a request Bean is equally rejected", async () => {
    const failure = expectFailure(await compileSource(sessionAndHolder("Lazy<Session>")));

    expect(failure.diagnostics.map((item) => item.code)).toEqual([
      "INVALID_REQUEST_SCOPE_DEPENDENCY",
    ]);
  });

  test("Current<T> is the legal singleton handle and emits a current edge", async () => {
    const result = await compileSourceOrThrow(sessionAndHolder("Current<Session>"));

    expect(manifestBean(result, "src/application.ts#Holder").dependencies).toEqual([
      {
        parameterIndex: 0,
        targetId: "src/application.ts#Session",
        mode: "current",
        source: expect.anything(),
      },
    ]);
    expect(generatedContent(result, "beans.ts")).toMatch(/resolver\.current<beanContract\d+>\(0\)/);
  });

  test("a request Bean may depend on a singleton directly", async () => {
    const result = await compileSourceOrThrow(
      [
        'import { Injectable, RequestScoped } from "@reforce/context";',
        "@Injectable() export class Clock {}",
        "@Injectable() @RequestScoped() export class Session {",
        "  constructor(readonly clock: Clock) {}",
        "}",
      ].join("\n"),
    );

    expect(manifestBean(result, "src/application.ts#Session").dependencies).toEqual([
      {
        parameterIndex: 0,
        targetId: "src/application.ts#Clock",
        mode: "eager",
        source: expect.anything(),
      },
    ]);
  });

  test("a request Bean may depend on a singleton lazily", async () => {
    const result = await compileSourceOrThrow(
      [
        'import { Injectable, type Lazy, RequestScoped } from "@reforce/context";',
        "@Injectable() export class Clock {}",
        "@Injectable() @RequestScoped() export class Session {",
        "  constructor(readonly clock: Lazy<Clock>) {}",
        "}",
      ].join("\n"),
    );

    expect(manifestBean(result, "src/application.ts#Session").dependencies).toEqual([
      {
        parameterIndex: 0,
        targetId: "src/application.ts#Clock",
        mode: "explicit-lazy",
        source: expect.anything(),
      },
    ]);
  });

  test("a Lazy edge between request Beans is rejected", async () => {
    const failure = expectFailure(
      await compileSource(
        [
          'import { Injectable, type Lazy, RequestScoped } from "@reforce/context";',
          "@Injectable() @RequestScoped() export class Session {}",
          "@Injectable() @RequestScoped() export class Peer {",
          "  constructor(readonly session: Lazy<Session>) {}",
          "}",
        ].join("\n"),
      ),
    );

    expect(failure.diagnostics.map((item) => item.code)).toEqual([
      "INVALID_REQUEST_SCOPE_DEPENDENCY",
    ]);
  });

  test("Current onto a singleton target is rejected", async () => {
    const failure = expectFailure(
      await compileSource(
        [
          'import { type Current, Injectable } from "@reforce/context";',
          "@Injectable() export class Clock {}",
          "@Injectable() export class Holder {",
          "  constructor(readonly clock: Current<Clock>) {}",
          "}",
        ].join("\n"),
      ),
    );

    expect(failure.diagnostics.map((item) => item.code)).toEqual(["INVALID_CURRENT_INJECTION"]);
  });

  test("Current inside a request Bean is rejected", async () => {
    const failure = expectFailure(
      await compileSource(
        [
          'import { type Current, Injectable, RequestScoped } from "@reforce/context";',
          "@Injectable() @RequestScoped() export class Session {}",
          "@Injectable() @RequestScoped() export class Peer {",
          "  constructor(readonly session: Current<Session>) {}",
          "}",
        ].join("\n"),
      ),
    );

    expect(failure.diagnostics.map((item) => item.code)).toEqual(["INVALID_CURRENT_INJECTION"]);
  });

  test("a request Bean cannot join a collection", async () => {
    const failure = expectFailure(
      await compileSource(
        [
          'import { Injectable, RequestScoped } from "@reforce/context";',
          "export interface Handler { handle(): void; }",
          "@Injectable() @RequestScoped() export class RequestHandler implements Handler {",
          "  handle(): void {}",
          "}",
          "@Injectable() export class Registry {",
          "  constructor(readonly handlers: readonly Handler[]) {}",
          "}",
        ].join("\n"),
      ),
    );

    expect(failure.diagnostics.map((item) => item.code)).toEqual([
      "INVALID_REQUEST_SCOPE_DEPENDENCY",
    ]);
  });

  test("readonly Current<T>[] is rejected as an unsupported combination", async () => {
    const failure = expectFailure(
      await compileSource(
        [
          'import { type Current, Injectable, RequestScoped } from "@reforce/context";',
          "@Injectable() @RequestScoped() export class Session {}",
          "@Injectable() export class Registry {",
          "  constructor(readonly sessions: readonly Current<Session>[]) {}",
          "}",
        ].join("\n"),
      ),
    );

    expect(failure.diagnostics.map((item) => item.code)).toEqual(["INVALID_COLLECTION_INJECTION"]);
  });

  test("Current<readonly T[]> is rejected as an unsupported combination", async () => {
    const failure = expectFailure(
      await compileSource(
        [
          'import { type Current, Injectable, RequestScoped } from "@reforce/context";',
          "@Injectable() @RequestScoped() export class Session {}",
          "@Injectable() export class Registry {",
          "  constructor(readonly sessions: Current<readonly Session[]>) {}",
          "}",
        ].join("\n"),
      ),
    );

    expect(failure.diagnostics.map((item) => item.code)).toEqual(["INVALID_COLLECTION_INJECTION"]);
  });

  test("Lazy<Current<T>> is rejected as a nested handle", async () => {
    const failure = expectFailure(
      await compileSource(
        [
          'import { type Current, Injectable, type Lazy, RequestScoped } from "@reforce/context";',
          "@Injectable() @RequestScoped() export class Session {}",
          "@Injectable() export class Holder {",
          "  constructor(readonly session: Lazy<Current<Session>>) {}",
          "}",
        ].join("\n"),
      ),
    );

    expect(failure.diagnostics.map((item) => item.code)).toEqual(["INVALID_CURRENT_INJECTION"]);
  });

  test("Current<Lazy<T>> is rejected as a nested handle", async () => {
    const failure = expectFailure(
      await compileSource(
        [
          'import { type Current, Injectable, type Lazy, RequestScoped } from "@reforce/context";',
          "@Injectable() @RequestScoped() export class Session {}",
          "@Injectable() export class Holder {",
          "  constructor(readonly session: Current<Lazy<Session>>) {}",
          "}",
        ].join("\n"),
      ),
    );

    expect(failure.diagnostics.map((item) => item.code)).toEqual(["INVALID_CURRENT_INJECTION"]);
  });

  test("a dependency cycle between request Beans is a compile error", async () => {
    const failure = expectFailure(
      await compileSource(
        [
          'import { Injectable, RequestScoped } from "@reforce/context";',
          "@Injectable() @RequestScoped() export class Alpha {",
          "  constructor(readonly beta: Beta) {}",
          "}",
          "@Injectable() @RequestScoped() export class Beta {",
          "  constructor(readonly alpha: Alpha) {}",
          "}",
        ].join("\n"),
      ),
    );

    const error = failure.diagnostics.find((item) => item.code === "REQUEST_DEPENDENCY_CYCLE");
    expect(failure.diagnostics.map((item) => item.code)).toEqual(["REQUEST_DEPENDENCY_CYCLE"]);
    const relatedText = (error?.related ?? []).map((item) => item.message).join("\n");
    expect(relatedText).toContain("src/application.ts#Alpha");
    expect(relatedText).toContain("src/application.ts#Beta");
  });
});

describe("determinism", () => {
  test("two compilations of the same request-scope project are byte-identical", async () => {
    const source = [
      'import { type Current, defineBean, Injectable, RequestScoped } from "@reforce/context";',
      "export class Trace { constructor(readonly label: string) {} }",
      "@Injectable() export class Clock {}",
      "@Injectable() @RequestScoped() export class Session {",
      "  constructor(readonly clock: Clock) {}",
      "}",
      'export const requestTrace = defineBean<Trace>({ scope: "request", create: async () => new Trace("trace") });',
      "@Injectable() export class Holder {",
      "  constructor(readonly session: Current<Session>) {}",
      "}",
    ].join("\n");
    const tree: ProjectTree = {
      "tsconfig.json": applicationTsconfig(),
      src: { "application.ts": source },
    };

    const first = await compileTree(tree);
    const second = await compileTree(tree);
    if (first.result.status === "failure" || second.result.status === "failure") {
      throw new Error("Expected both compilations to succeed");
    }

    for (const filePath of ["beans.ts", "manifest.json"] as const) {
      expect(generatedContent(second.result, filePath)).toBe(
        generatedContent(first.result, filePath),
      );
    }
  });
});

describe("generated request execution", () => {
  test("the generated definition typechecks and isolates concurrent requests", async () => {
    const project = await createTemporaryProject({
      "tsconfig.json": applicationTsconfig(),
      src: {
        "application.ts": [
          'import { type Current, defineBean, Injectable, RequestScoped } from "@reforce/context";',
          "",
          "@Injectable()",
          "export class Clock {",
          "  now(): number {",
          "    return 42;",
          "  }",
          "}",
          "",
          "@Injectable() @RequestScoped()",
          "export class RequestContext {",
          '  id = "unseeded";',
          "}",
          "",
          "@Injectable() @RequestScoped()",
          "export class Session {",
          "  readonly label: string;",
          "  constructor(readonly ctx: RequestContext, readonly clock: Clock) {",
          '    this.label = [ctx.id, clock.now()].join("@");',
          "  }",
          "}",
          "",
          "export class Trace {",
          "  constructor(readonly entries: readonly string[]) {}",
          "}",
          "",
          "export const requestTrace = defineBean<Trace>({",
          '  scope: "request",',
          "  create: async () => new Trace([]),",
          "});",
          "",
          "@Injectable()",
          "export class SessionReader {",
          "  constructor(readonly session: Current<Session>) {}",
          "  read(): string {",
          "    return this.session.get().label;",
          "  }",
          "}",
          "",
        ].join("\n"),
      },
    });
    temporaryProjects.push(project);
    await linkApplicationPackages(project.projectRoot);
    const compiler = createCompiler();
    const resolution = await compiler.resolveProject({ projectDirectory: project.projectRoot });
    if (resolution.status === "failure") {
      throw new Error(JSON.stringify(resolution.diagnostics));
    }
    const result = await compiler.compile({ project: resolution.project });
    if (result.status === "failure") {
      throw new Error(JSON.stringify(result.diagnostics));
    }
    const generatedDirectory = path.join(project.projectRoot, ".reforce", "generated");
    await mkdir(generatedDirectory, { recursive: true });
    await Promise.all(
      result.files.map((file) => writeFile(path.join(generatedDirectory, file.path), file.content)),
    );
    await writeFile(
      path.join(project.projectRoot, "integration.ts"),
      [
        'import { RequestContextMissingError } from "@reforce/context";',
        'import { bootstrap } from "./.reforce/generated/bootstrap.js";',
        'import { RequestContext, SessionReader } from "./src/application.js";',
        "",
        "function seededContext(id: string): RequestContext {",
        "  const ctx = new RequestContext();",
        "  ctx.id = id;",
        "  return ctx;",
        "}",
        "",
        "const context = await bootstrap();",
        "const reader = context.get(SessionReader);",
        "const [alpha, beta] = await Promise.all([",
        '  context.runInRequestScope([{ target: RequestContext, instance: seededContext("alpha") }], async () => {',
        "    await Promise.resolve();",
        "    return reader.read();",
        "  }),",
        '  context.runInRequestScope([{ target: RequestContext, instance: seededContext("beta") }], async () => reader.read()),',
        "]);",
        "const memoized = await context.runInRequestScope([], async () => {",
        "  return reader.session.get() === reader.session.get();",
        "});",
        'let missing = "";',
        "try {",
        "  reader.session.get();",
        "} catch (error) {",
        '  missing = error instanceof RequestContextMissingError ? error.code : "unexpected";',
        "}",
        "await context.close();",
        "console.log(JSON.stringify({ alpha, beta, memoized, missing }));",
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
    expect(execution.stdout).toBe(
      JSON.stringify({
        alpha: "alpha@42",
        beta: "beta@42",
        memoized: true,
        missing: "REQUEST_CONTEXT_MISSING",
      }),
    );
  });
});
