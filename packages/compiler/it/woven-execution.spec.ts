import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  bundleEntry,
  createTemporaryProject,
  resolveNodeExecutable,
  runCommand,
  type TemporaryProject,
} from "@reforce/tooling-testing";
import { afterAll, expect, test } from "vitest";
import { createCompiler } from "@/index";
import { applicationTsconfig, linkApplicationPackages } from "./support/project";

// $Woven 执行 IT（ADR 0008 AM1，#202）：生成物先过 tsc（typed-edge：override 签名、链表
// 字面量、resolver 槽位全部结构校验）再真实执行。钉住——洋葱序与 ctx.value、self-invocation
// 被拦截（ADR 核心卖点：$Woven override 让 this.save() 也走链）、request-scoped 织入路径、
// 拦截器↔被织 bean 成环走 cycle-proxy、抽象基类继承的类型边角。

const nodeExecutable = await resolveNodeExecutable();
const temporaryProjects: TemporaryProject[] = [];

afterAll(async () => {
  await Promise.all(temporaryProjects.splice(0).map((project) => project.cleanup()));
});

async function compileAndRun(
  sources: Record<string, string>,
  entryLines: readonly string[],
): Promise<string> {
  const project = await createTemporaryProject({
    "tsconfig.json": applicationTsconfig(),
    src: sources,
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
  await writeFile(path.join(project.projectRoot, "integration.ts"), [...entryLines, ""].join("\n"));
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
  expect(typecheck.stderr).toBe("");
  expect(typecheck.stdout).toBe("");
  expect(typecheck.exitCode).toBe(0);
  await bundleEntry({ entry: "integration.ts", cwd: project.projectRoot, outdir: "dist" });
  const execution = await runCommand(
    nodeExecutable,
    [path.join(project.projectRoot, "dist", "integration.js")],
    { cwd: project.projectRoot },
  );
  expect(execution.stderr).toBe("");
  expect(execution.exitCode).toBe(0);
  if (typeof execution.stdout !== "string") {
    throw new Error("Expected string stdout from the integration run");
  }
  return execution.stdout;
}

const markersSource = [
  'import { defineMethodMarker } from "@reforce/context";',
  'export const Audited = defineMethodMarker<{ label: string }>("audited");',
  'export const Traced = defineMethodMarker<{ detail: boolean } | undefined>("traced");',
].join("\n");

test("weaves the flattened onion chain and intercepts self-invocation through the override", async () => {
  const stdout = await compileAndRun(
    {
      "markers.ts": markersSource,
      "interceptors.ts": [
        'import { Injectable, Interceptor } from "@reforce/context";',
        'import type { MethodInterceptor, MethodInvocationContext } from "@reforce/context";',
        'import { Audited, Traced } from "./markers";',
        "",
        "export const trace: string[] = [];",
        "",
        "@Injectable()",
        '@Interceptor({ marker: Traced, phase: "observability" })',
        "export class TraceInterceptor implements MethodInterceptor<{ detail: boolean } | undefined> {",
        "  async intercept(context: MethodInvocationContext<{ detail: boolean } | undefined>, next: () => Promise<unknown>): Promise<unknown> {",
        '    trace.push(["trace:before", context.method, String(context.value === undefined)].join(":"));',
        "    const result = await next();",
        '    trace.push("trace:after");',
        "    return result;",
        "  }",
        "}",
        "",
        "@Injectable()",
        "@Interceptor({ marker: Audited })",
        "export class AuditInterceptor implements MethodInterceptor<{ label: string }> {",
        "  async intercept(context: MethodInvocationContext<{ label: string }>, next: () => Promise<unknown>): Promise<unknown> {",
        '    trace.push(["audit:before", context.value.label].join(":"));',
        "    const result = await next();",
        '    trace.push("audit:after");',
        "    return result;",
        "  }",
        "}",
      ].join("\n"),
      "repo.ts": [
        'import { Injectable } from "@reforce/context";',
        'import { trace } from "./interceptors";',
        'import { Audited, Traced } from "./markers";',
        "",
        "export abstract class BaseRepo {",
        "  abstract save(): Promise<string>;",
        "}",
        "",
        "@Injectable()",
        "export class Repo extends BaseRepo {",
        '  @Audited({ label: "save" })',
        "  @Traced()",
        "  override async save(): Promise<string> {",
        '    trace.push("save");',
        '    return "saved";',
        "  }",
        "",
        "  async saveAll(): Promise<string> {",
        '    trace.push("saveAll");',
        "    return await this.save();",
        "  }",
        "}",
      ].join("\n"),
    },
    [
      'import { bootstrap } from "./.reforce/generated/bootstrap.js";',
      'import { trace } from "./src/interceptors.js";',
      'import { Repo } from "./src/repo.js";',
      "",
      "const context = await bootstrap();",
      "const result = await context.get(Repo).saveAll();",
      "await context.close();",
      "console.log(JSON.stringify({ result, trace }));",
    ],
  );

  // saveAll 未被标记、不进 override；它内部的 this.save() 依然走 $Woven 的 override——
  // self-invocation 被拦截正是编译期子类织入对 Spring 动态代理的差异卖点。
  expect(JSON.parse(stdout)).toEqual({
    result: "saved",
    trace: [
      "saveAll",
      "trace:before:save:true",
      "audit:before:save",
      "save",
      "audit:after",
      "trace:after",
    ],
  });
});

test("weaves request-scoped beans on the request construction path", async () => {
  const stdout = await compileAndRun(
    {
      "markers.ts": markersSource,
      "application.ts": [
        'import { type Current, Injectable, Interceptor, RequestScoped } from "@reforce/context";',
        'import type { MethodInterceptor, MethodInvocationContext } from "@reforce/context";',
        'import { Audited } from "./markers";',
        "",
        "export const trace: string[] = [];",
        "",
        "@Injectable()",
        "@Interceptor({ marker: Audited })",
        "export class AuditInterceptor implements MethodInterceptor<{ label: string }> {",
        "  async intercept(context: MethodInvocationContext<{ label: string }>, next: () => Promise<unknown>): Promise<unknown> {",
        '    trace.push(["audit:before", context.value.label].join(":"));',
        "    const result = await next();",
        '    trace.push("audit:after");',
        "    return result;",
        "  }",
        "}",
        "",
        "@Injectable() @RequestScoped()",
        "export class RequestRepo {",
        '  @Audited({ label: "request" })',
        "  async save(): Promise<string> {",
        '    trace.push("save");',
        '    return "saved";',
        "  }",
        "}",
        "",
        "@Injectable()",
        "export class RepoReader {",
        "  constructor(readonly repo: Current<RequestRepo>) {}",
        "}",
      ].join("\n"),
    },
    [
      'import { bootstrap } from "./.reforce/generated/bootstrap.js";',
      'import { RepoReader, trace } from "./src/application.js";',
      "",
      "const context = await bootstrap();",
      "const reader = context.get(RepoReader);",
      "const result = await context.runInRequestScope([], async () => await reader.repo.get().save());",
      "await context.close();",
      "console.log(JSON.stringify({ result, trace }));",
    ],
  );

  expect(JSON.parse(stdout)).toEqual({
    result: "saved",
    trace: ["audit:before:request", "save", "audit:after"],
  });
});

test("constructs interceptor and woven bean cycles through the cycle proxy", async () => {
  const stdout = await compileAndRun(
    {
      "markers.ts": markersSource,
      "application.ts": [
        'import { Injectable, Interceptor } from "@reforce/context";',
        'import type { MethodInterceptor, MethodInvocationContext } from "@reforce/context";',
        'import { Audited } from "./markers";',
        "",
        "export const trace: string[] = [];",
        "",
        "@Injectable()",
        "export class Repo {",
        '  @Audited({ label: "save" })',
        "  async save(): Promise<string> {",
        '    trace.push("save");',
        '    return "saved";',
        "  }",
        "",
        "  tag(): string {",
        '    return "repo";',
        "  }",
        "}",
        "",
        "@Injectable()",
        "@Interceptor({ marker: Audited })",
        "export class AuditInterceptor implements MethodInterceptor<{ label: string }> {",
        "  constructor(private readonly repo: Repo) {}",
        "",
        "  async intercept(context: MethodInvocationContext<{ label: string }>, next: () => Promise<unknown>): Promise<unknown> {",
        '    trace.push(["audit:before", this.repo.tag()].join(":"));',
        "    const result = await next();",
        '    trace.push("audit:after");',
        "    return result;",
        "  }",
        "}",
      ].join("\n"),
    },
    [
      'import { bootstrap } from "./.reforce/generated/bootstrap.js";',
      'import { Repo, trace } from "./src/application.js";',
      "",
      "const context = await bootstrap();",
      "const result = await context.get(Repo).save();",
      "await context.close();",
      "console.log(JSON.stringify({ result, trace }));",
    ],
  );

  expect(JSON.parse(stdout)).toEqual({
    result: "saved",
    trace: ["audit:before:repo", "save", "audit:after"],
  });
});

// 事务执行链路（ADR 0008 AM2，#204 定案 5/6）：合成注册的框架拦截器 + 应用侧
// TransactionManager 实现真实走通——生成物过 tsc（框架契约的 typed-edge）、事务开闭与
// 回滚经 fake manager 可见、activeTransaction() 在被织方法内可读。
test("weaves @Transactional through the synthesized framework interceptor", async () => {
  const stdout = await compileAndRun(
    {
      "manager.ts": [
        'import { Injectable } from "@reforce/context";',
        'import type { TransactionManager, TransactionOptions } from "@reforce/context";',
        "",
        "export const events: string[] = [];",
        "",
        "@Injectable()",
        "export class RecordingManager implements TransactionManager<string> {",
        "  private sequence = 0;",
        "  async withTransaction<T>(options: TransactionOptions, fn: (resource: string) => Promise<T>): Promise<T> {",
        "    this.sequence += 1;",
        "    const resource = `tx${this.sequence}`;",
        '    events.push(`begin:${resource}:${options.isolation ?? "default"}`);',
        "    try {",
        "      const result = await fn(resource);",
        "      events.push(`commit:${resource}`);",
        "      return result;",
        "    } catch (error) {",
        "      events.push(`rollback:${resource}`);",
        "      throw error;",
        "    }",
        "  }",
        "}",
      ].join("\n"),
      "orders.ts": [
        'import { activeTransaction, Injectable, Transactional } from "@reforce/context";',
        'import { events } from "./manager";',
        "",
        "@Injectable()",
        "export class Orders {",
        "  @Transactional()",
        "  async save(): Promise<string> {",
        "    events.push(`inside:${String(activeTransaction()?.resource)}`);",
        '    return "saved";',
        "  }",
        "",
        '  @Transactional({ isolation: "SERIALIZABLE" })',
        "  async fail(): Promise<void> {",
        '    throw new Error("boom");',
        "  }",
        "}",
      ].join("\n"),
    },
    [
      'import { bootstrap } from "./.reforce/generated/bootstrap.js";',
      'import { events } from "./src/manager.js";',
      'import { Orders } from "./src/orders.js";',
      "",
      "const context = await bootstrap();",
      "const result = await context.get(Orders).save();",
      'let caught = "";',
      "try {",
      "  await context.get(Orders).fail();",
      "} catch (error) {",
      "  caught = error instanceof Error ? error.message : String(error);",
      "}",
      "await context.close();",
      "console.log(JSON.stringify({ result, caught, events }));",
    ],
  );

  expect(JSON.parse(stdout)).toEqual({
    result: "saved",
    caught: "boom",
    events: [
      "begin:tx1:default",
      "inside:tx1",
      "commit:tx1",
      "begin:tx2:SERIALIZABLE",
      "rollback:tx2",
    ],
  });
});
