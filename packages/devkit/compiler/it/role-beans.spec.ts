import {
  createTemporaryProject,
  type ProjectTree,
  type TemporaryProject,
} from "@reforce/tooling-testing";
import { afterAll, describe, expect, test } from "vitest";
import { type CompileResult, createCompiler, type GeneratedFile } from "@/index";
import { type CompileSuccess, linkApplicationPackages, linkWebPackage } from "./support/project";

// 角色 bean 一等化 IT（修订 ADR 0006 W3 与 ADR 0008 AM1 的定案）：角色装饰器蕴含 bean 身份，
// 角色 bean 照常构造与注入自己的依赖，但不进按类型解析的候选集——单边注入硬错并给出路，
// 集合注入静默排除（空集合本就合法）。
//
// 合成的事务拦截器同样带 role（transaction-weaving.ts），但今天不可能写出触发它的用例：
// 它的契约符号只从 @reforce/transaction/generated-runtime 导出，而框架符号短路只认
// "@reforce/core" 这个精确 specifier，用户源码里根本拿不到这个类型。那条 role 是为了让
// 规则对合成 bean 与手写 @Interceptor 保持同一句话，不是当下可达的行为。

type FailureResult = Extract<CompileResult, { readonly status: "failure" }>;

const temporaryProjects: TemporaryProject[] = [];

afterAll(async () => {
  await Promise.all(temporaryProjects.splice(0).map((project) => project.cleanup()));
});

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

async function compileSources(sources: Record<string, string>): Promise<CompileResult> {
  const tree: ProjectTree = { "tsconfig.json": webApplicationTsconfig(), src: sources };
  const project = await createTemporaryProject(tree);
  temporaryProjects.push(project);
  await linkApplicationPackages(project.projectRoot);
  await linkWebPackage(project.projectRoot);
  const compiler = createCompiler();
  const resolution = await compiler.resolveProject({ projectDirectory: project.projectRoot });
  if (resolution.status === "failure") {
    throw new Error(JSON.stringify(resolution.diagnostics));
  }
  return await compiler.compile({ project: resolution.project });
}

async function compileSourcesOrThrow(sources: Record<string, string>): Promise<CompileSuccess> {
  const result = await compileSources(sources);
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
  readonly members?: readonly { readonly targetId: string }[];
}

interface ManifestBean {
  readonly id: string;
  readonly dependencies: readonly ManifestDependency[];
}

function manifestBean(result: CompileSuccess, id: string): ManifestBean {
  const beans: readonly ManifestBean[] = JSON.parse(
    generatedContent(result, "manifest.json"),
  ).beans;
  const bean = beans.find((candidate) => candidate.id === id);
  if (bean === undefined) {
    throw new Error(`Missing manifest Bean ${id}`);
  }
  return bean;
}

const auditContract = ["export interface AuditSink {", "  record(line: string): void;", "}"].join(
  "\n",
);

const tokenService = [
  'import { Injectable } from "@reforce/core";',
  "@Injectable()",
  "export class TokenService {",
  "  valid(token: string): boolean {",
  "    return token.length > 0;",
  "  }",
  "}",
].join("\n");

const roleGuard = [
  'import { Middleware, type RequestContext } from "@reforce/web-core";',
  'import { TokenService } from "@/token-service";',
  '@Middleware({ phase: "admission", global: true })',
  "export class RoleGuard {",
  "  constructor(private readonly tokens: TokenService) {}",
  "  handle(context: RequestContext, next: () => Promise<Response>): Promise<Response> {",
  "    return this.tokens.valid(context.path) ? next() : next();",
  "  }",
  "}",
].join("\n");

describe("role Beans construct and inject like any other Bean", () => {
  test("a middleware resolves its own constructor dependency", async () => {
    const result = await compileSourcesOrThrow({
      "token-service.ts": tokenService,
      "role-guard.ts": roleGuard,
    });

    expect(
      manifestBean(result, "src/role-guard.ts#RoleGuard").dependencies.map(
        ({ parameterIndex, mode, targetId }) => ({ parameterIndex, mode, targetId }),
      ),
    ).toEqual([
      { parameterIndex: 0, mode: "eager", targetId: "src/token-service.ts#TokenService" },
    ]);
  });
});

describe("role Beans stay out of the resolvable candidate set", () => {
  test("injecting a middleware by its own class is rejected with a way out", async () => {
    const result = await compileSources({
      "token-service.ts": tokenService,
      "role-guard.ts": roleGuard,
      "reporting.ts": [
        'import { Injectable } from "@reforce/core";',
        'import { RoleGuard } from "@/role-guard";',
        "@Injectable()",
        "export class Reporting {",
        "  constructor(private readonly guard: RoleGuard) {}",
        "}",
      ].join("\n"),
    });

    const failure = expectFailure(result);
    expect(failure.diagnostics.map((item) => item.code)).toEqual(["ROLE_BEAN_AS_DEPENDENCY"]);
    expect(failure.diagnostics[0]?.message).toContain("RoleGuard plays the middleware role");
    expect(failure.diagnostics[0]?.help).toContain("@Injectable() service");
  });

  test("injecting a controller by an implemented interface is rejected", async () => {
    const result = await compileSources({
      "audit-sink.ts": auditContract,
      "audit-controller.ts": [
        'import { Controller, Get } from "@reforce/web-core";',
        'import type { AuditSink } from "@/audit-sink";',
        '@Controller("/audit")',
        "export class AuditController implements AuditSink {",
        "  record(line: string): void {",
        "    void line;",
        "  }",
        "  @Get()",
        "  list(): void {}",
        "}",
      ].join("\n"),
      "reporting.ts": [
        'import { Injectable } from "@reforce/core";',
        'import type { AuditSink } from "@/audit-sink";',
        "@Injectable()",
        "export class Reporting {",
        "  constructor(private readonly sink: AuditSink) {}",
        "}",
      ].join("\n"),
    });

    expect(expectFailure(result).diagnostics.map((item) => item.code)).toEqual([
      "ROLE_BEAN_AS_DEPENDENCY",
    ]);
  });

  test("injecting an interceptor by its own class is rejected", async () => {
    const result = await compileSources({
      "markers.ts": [
        'import { defineMethodMarker } from "@reforce/core";',
        'export const Audited = defineMethodMarker<{ label: string }>("audited");',
      ].join("\n"),
      "interceptor.ts": [
        'import { Interceptor, type MethodInterceptor, type MethodInvocationContext } from "@reforce/core";',
        'import { Audited } from "@/markers";',
        "@Interceptor({ marker: Audited })",
        "export class AuditInterceptor implements MethodInterceptor<{ label: string }> {",
        "  async intercept(context: MethodInvocationContext<{ label: string }>, next: () => Promise<unknown>): Promise<unknown> {",
        "    void context;",
        "    return await next();",
        "  }",
        "}",
      ].join("\n"),
      "reporting.ts": [
        'import { Injectable } from "@reforce/core";',
        'import { AuditInterceptor } from "@/interceptor";',
        "@Injectable()",
        "export class Reporting {",
        "  constructor(private readonly interceptor: AuditInterceptor) {}",
        "}",
      ].join("\n"),
    });

    const failure = expectFailure(result);
    expect(failure.diagnostics.map((item) => item.code)).toEqual(["ROLE_BEAN_AS_DEPENDENCY"]);
    expect(failure.diagnostics[0]?.message).toContain(
      "AuditInterceptor plays the interceptor role",
    );
  });
});

describe("role Beans stay out of collection membership", () => {
  test("a middleware implementing the collected contract does not join the collection", async () => {
    const result = await compileSourcesOrThrow({
      "audit-sink.ts": auditContract,
      "file-sink.ts": [
        'import { Injectable } from "@reforce/core";',
        'import type { AuditSink } from "@/audit-sink";',
        "@Injectable()",
        "export class FileSink implements AuditSink {",
        "  record(line: string): void {",
        "    void line;",
        "  }",
        "}",
      ].join("\n"),
      "audit-middleware.ts": [
        'import { Middleware, type RequestContext } from "@reforce/web-core";',
        'import type { AuditSink } from "@/audit-sink";',
        "@Middleware({ global: true })",
        "export class AuditMiddleware implements AuditSink {",
        "  record(line: string): void {",
        "    void line;",
        "  }",
        "  handle(context: RequestContext, next: () => Promise<Response>): Promise<Response> {",
        "    void context;",
        "    return next();",
        "  }",
        "}",
      ].join("\n"),
      "reporting.ts": [
        'import { Injectable } from "@reforce/core";',
        'import type { AuditSink } from "@/audit-sink";',
        "@Injectable()",
        "export class Reporting {",
        "  constructor(private readonly sinks: readonly AuditSink[]) {}",
        "}",
      ].join("\n"),
    });

    expect(manifestBean(result, "src/reporting.ts#Reporting").dependencies[0]?.members).toEqual([
      { targetId: "src/file-sink.ts#FileSink", mode: "eager" },
    ]);
  });
});
