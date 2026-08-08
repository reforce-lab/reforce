import {
  createTemporaryProject,
  type ProjectTree,
  type TemporaryProject,
} from "@reforce/tooling-testing";
import { afterAll, describe, expect, test } from "vitest";
import { type CompileResult, createCompiler } from "@/index";
import { applicationTsconfig } from "./support/project";

// 方法级织入的硬错矩阵 IT（ADR 0008 AM1，#202）：要么生效、要么编译错，无静默第三态。
// 每条硬错一例，双侧定位的条目（同键重复、override 丢标记）断言 related span 存在。

type FailureResult = Extract<CompileResult, { readonly status: "failure" }>;

const temporaryProjects: TemporaryProject[] = [];

afterAll(async () => {
  await Promise.all(temporaryProjects.splice(0).map((project) => project.cleanup()));
});

async function compileSources(sources: Record<string, string>): Promise<CompileResult> {
  const tree: ProjectTree = {
    "tsconfig.json": applicationTsconfig({ compilerOptions: { paths: { "@/*": ["./src/*"] } } }),
    src: sources,
  };
  const project = await createTemporaryProject(tree);
  temporaryProjects.push(project);
  const compiler = createCompiler();
  const resolution = await compiler.resolveProject({ projectDirectory: project.projectRoot });
  if (resolution.status === "failure") {
    throw new Error(JSON.stringify(resolution.diagnostics));
  }
  return await compiler.compile({ project: resolution.project });
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

const markerSource = [
  'import { defineMethodMarker } from "@reforce/core";',
  'export const Audited = defineMethodMarker<{ label: string }>("audited");',
].join("\n");

const auditInterceptorSource = [
  'import { Injectable, Interceptor } from "@reforce/core";',
  'import type { MethodInterceptor, MethodInvocationContext } from "@reforce/core";',
  'import { Audited } from "@/markers";',
  "@Interceptor({ marker: Audited })",
  "export class AuditInterceptor implements MethodInterceptor<{ label: string }> {",
  "  async intercept(context: MethodInvocationContext<{ label: string }>, next: () => Promise<unknown>): Promise<unknown> {",
  "    return await next();",
  "  }",
  "}",
].join("\n");

describe("method marker declaration shape (hard error #1)", () => {
  test("rejects a non-const declaration", async () => {
    const result = await compileSources({
      "markers.ts": [
        'import { defineMethodMarker } from "@reforce/core";',
        'export let Audited = defineMethodMarker<{ label: string }>("audited");',
      ].join("\n"),
    });

    expect(failureCodes(result)).toContain("INVALID_METHOD_MARKER");
  });

  test("rejects a missing or empty string literal key", async () => {
    const result = await compileSources({
      "markers.ts": [
        'import { defineMethodMarker } from "@reforce/core";',
        'export const Audited = defineMethodMarker<{ label: string }>("");',
      ].join("\n"),
    });

    expect(failureCodes(result)).toContain("INVALID_METHOD_MARKER");
  });

  // key 空间是全局的（#284，同 #254 的 route marker）：织入表按裸字符串 key 存，撞 key 的
  // 两个 marker 互为别名，拦截器会对另一个 marker 标记的方法生效。
  test("two declarations sharing one key across files are rejected with both sites", async () => {
    const result = await compileSources({
      "audit-markers.ts": [
        'import { defineMethodMarker } from "@reforce/core";',
        'export const AuditTrail = defineMethodMarker<{ label: string }>("audited");',
      ].join("\n"),
      "markers.ts": markerSource,
    });

    const failure = expectFailure(result);
    expect(failure.diagnostics.map((item) => item.code)).toEqual(["DUPLICATE_METHOD_MARKER"]);
    expect(failure.diagnostics[0]?.message).toContain("AuditTrail");
    expect(failure.diagnostics[0]?.related).toHaveLength(1);
  });
});

describe("marked bean shape (hard errors #2-#5)", () => {
  test("rejects a marked method on a class that is not an @Injectable class provider", async () => {
    const result = await compileSources({
      "markers.ts": markerSource,
      "service.ts": [
        'import { Audited } from "@/markers";',
        "export class PlainService {",
        '  @Audited({ label: "save" })',
        "  async save(): Promise<void> {}",
        "}",
      ].join("\n"),
    });

    expect(failureCodes(result)).toContain("INVALID_METHOD_MARKER");
  });

  test("rejects a marked static method", async () => {
    const result = await compileSources({
      "markers.ts": markerSource,
      "service.ts": [
        'import { Injectable } from "@reforce/core";',
        'import { Audited } from "@/markers";',
        "@Injectable()",
        "export class StaticService {",
        '  @Audited({ label: "save" })',
        "  static async save(): Promise<void> {}",
        "}",
      ].join("\n"),
    });

    expect(failureCodes(result)).toContain("INVALID_METHOD_MARKER");
  });

  test("rejects a marked sync method: weaving must not turn a sync signature async", async () => {
    const result = await compileSources({
      "markers.ts": markerSource,
      "service.ts": [
        'import { Injectable } from "@reforce/core";',
        'import { Audited } from "@/markers";',
        "@Injectable()",
        "export class SyncService {",
        '  @Audited({ label: "save" })',
        "  save(): void {}",
        "}",
      ].join("\n"),
    });

    const failure = expectFailure(result);
    const diagnostic = failure.diagnostics.find((item) => item.code === "INVALID_METHOD_MARKER");
    expect(diagnostic?.message).toContain("async");
  });

  test("rejects a marker on a class position", async () => {
    const result = await compileSources({
      "markers.ts": markerSource,
      "service.ts": [
        'import { Injectable } from "@reforce/core";',
        'import { Audited } from "@/markers";',
        "@Injectable()",
        '@Audited({ label: "class" })',
        "export class ClassMarked {",
        "  async save(): Promise<void> {}",
        "}",
      ].join("\n"),
    });

    expect(failureCodes(result)).toContain("INVALID_METHOD_MARKER");
  });
});

describe("marker values (hard errors #6-#7)", () => {
  test("rejects the same marker twice on one method with both spans", async () => {
    const result = await compileSources({
      "markers.ts": markerSource,
      "service.ts": [
        'import { Injectable } from "@reforce/core";',
        'import { Audited } from "@/markers";',
        "@Injectable()",
        "export class DuplicateService {",
        '  @Audited({ label: "one" })',
        '  @Audited({ label: "two" })',
        "  async save(): Promise<void> {}",
        "}",
      ].join("\n"),
    });

    const failure = expectFailure(result);
    const duplicate = failure.diagnostics.find(
      (item) => item.code === "INVALID_METHOD_MARKER_VALUE" && item.message.includes("twice"),
    );
    expect(duplicate).toBeDefined();
    expect(duplicate?.sourceSpan).toBeDefined();
    expect(duplicate?.related.at(0)?.sourceSpan).toBeDefined();
  });

  test("rejects a non-literal marker value", async () => {
    const result = await compileSources({
      "markers.ts": markerSource,
      "service.ts": [
        'import { Injectable } from "@reforce/core";',
        'import { Audited } from "@/markers";',
        'const label = { label: "computed" };',
        "@Injectable()",
        "export class ComputedService {",
        "  @Audited(label)",
        "  async save(): Promise<void> {}",
        "}",
      ].join("\n"),
    });

    expect(failureCodes(result)).toContain("INVALID_METHOD_MARKER_VALUE");
  });
});

describe("interceptor declarations (hard error #8)", () => {
  test("rejects an interceptor class marked @Injectable: the role decorator already declares the Bean", async () => {
    const result = await compileSources({
      "markers.ts": markerSource,
      "interceptor.ts": [
        'import { Injectable, Interceptor } from "@reforce/core";',
        'import { Audited } from "@/markers";',
        "@Injectable()",
        "@Interceptor({ marker: Audited })",
        "export class BareInterceptor {}",
      ].join("\n"),
    });

    expect(failureCodes(result)).toContain("INVALID_DECORATOR_USAGE");
  });

  test("rejects a request-scoped interceptor", async () => {
    const result = await compileSources({
      "markers.ts": markerSource,
      "interceptor.ts": [
        'import { Interceptor, RequestScoped } from "@reforce/core";',
        'import { Audited } from "@/markers";',
        "@RequestScoped()",
        "@Interceptor({ marker: Audited })",
        "export class RequestScopedInterceptor {}",
      ].join("\n"),
    });

    expect(failureCodes(result)).toContain("INVALID_INTERCEPTOR_DECLARATION");
  });

  test("rejects options without a marker reference", async () => {
    const result = await compileSources({
      "markers.ts": markerSource,
      "interceptor.ts": [
        'import { Injectable, Interceptor } from "@reforce/core";',
        '@Interceptor({ phase: "cache" })',
        "export class MarkerlessInterceptor {}",
      ].join("\n"),
    });

    expect(failureCodes(result)).toContain("INVALID_INTERCEPTOR_DECLARATION");
  });

  test("rejects an unknown option key and an unknown phase", async () => {
    const unknownKey = await compileSources({
      "markers.ts": markerSource,
      "interceptor.ts": [
        'import { Injectable, Interceptor } from "@reforce/core";',
        'import { Audited } from "@/markers";',
        "@Interceptor({ marker: Audited, global: true })",
        "export class UnknownOptionInterceptor {}",
      ].join("\n"),
    });
    expect(failureCodes(unknownKey)).toContain("INVALID_INTERCEPTOR_DECLARATION");

    const unknownPhase = await compileSources({
      "markers.ts": markerSource,
      "interceptor.ts": [
        'import { Injectable, Interceptor } from "@reforce/core";',
        'import { Audited } from "@/markers";',
        '@Interceptor({ marker: Audited, phase: "security" })',
        "export class UnknownPhaseInterceptor {}",
      ].join("\n"),
    });
    expect(failureCodes(unknownPhase)).toContain("INVALID_INTERCEPTOR_DECLARATION");
  });

  test("rejects a marker reference that is not a defineMethodMarker declaration", async () => {
    const result = await compileSources({
      "markers.ts": markerSource,
      "interceptor.ts": [
        'import { Injectable, Interceptor } from "@reforce/core";',
        "@Injectable()",
        "export class NotAMarker {}",
        "@Interceptor({ marker: NotAMarker })",
        "export class WrongMarkerInterceptor {}",
      ].join("\n"),
    });

    expect(failureCodes(result)).toContain("INVALID_INTERCEPTOR_DECLARATION");
  });

  test("rejects @Interceptor on a method position", async () => {
    const result = await compileSources({
      "markers.ts": markerSource,
      "interceptor.ts": auditInterceptorSource,
      "service.ts": [
        'import { Injectable, Interceptor } from "@reforce/core";',
        'import { Audited } from "@/markers";',
        "@Injectable()",
        "export class MisplacedService {",
        "  @Interceptor({ marker: Audited })",
        "  async save(): Promise<void> {}",
        "}",
      ].join("\n"),
    });

    expect(failureCodes(result)).toContain("INVALID_INTERCEPTOR_DECLARATION");
  });
});

describe("bean inheritance (hard error #9)", () => {
  test("rejects an override that drops the base class marker, with both spans", async () => {
    const result = await compileSources({
      "markers.ts": markerSource,
      "base.ts": [
        'import { Injectable } from "@reforce/core";',
        'import { Audited } from "@/markers";',
        "@Injectable()",
        "export class BaseService {",
        '  @Audited({ label: "base" })',
        "  async save(): Promise<string> {",
        '    return "base";',
        "  }",
        "}",
      ].join("\n"),
    });

    // 基线：父类自身合法。
    expect(result.status).toBe("success");

    const dropped = await compileSources({
      "markers.ts": markerSource,
      "base.ts": [
        'import { Injectable } from "@reforce/core";',
        'import { Audited } from "@/markers";',
        "@Injectable()",
        "export class BaseService {",
        '  @Audited({ label: "base" })',
        "  async save(): Promise<string> {",
        '    return "base";',
        "  }",
        "}",
      ].join("\n"),
      "child.ts": [
        'import { Injectable } from "@reforce/core";',
        'import { BaseService } from "@/base";',
        "@Injectable()",
        "export class ChildService extends BaseService {",
        "  override async save(): Promise<string> {",
        '    return "child";',
        "  }",
        "}",
      ].join("\n"),
    });

    const failure = expectFailure(dropped);
    const diagnostic = failure.diagnostics.find(
      (item) => item.code === "INVALID_METHOD_MARKER" && item.message.includes("overrides"),
    );
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.sourceSpan).toBeDefined();
    expect(diagnostic?.related.at(0)?.sourceSpan).toBeDefined();
  });

  test("accepts an override that restates the marker", async () => {
    const result = await compileSources({
      "markers.ts": markerSource,
      "base.ts": [
        'import { Injectable } from "@reforce/core";',
        'import { Audited } from "@/markers";',
        "@Injectable()",
        "export class BaseService {",
        '  @Audited({ label: "base" })',
        "  async save(): Promise<string> {",
        '    return "base";',
        "  }",
        "}",
      ].join("\n"),
      "child.ts": [
        'import { Injectable } from "@reforce/core";',
        'import { BaseService } from "@/base";',
        'import { Audited } from "@/markers";',
        "@Injectable()",
        "export class ChildService extends BaseService {",
        '  @Audited({ label: "child" })',
        "  override async save(): Promise<string> {",
        '    return "child";',
        "  }",
        "}",
      ].join("\n"),
    });

    expect(result.status).toBe("success");
  });
});
