import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { normalizeTerminalOutput } from "@reforce/tooling-testing";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { renderDiagnostic } from "@/diagnostic-render";
import type { ReportedDiagnostic } from "@/reporter";

const stream = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});

const sourceText = [
  "export class OrderService {",
  "  constructor(private readonly gateway: PaymentGateway) {}",
  "}",
  "",
].join("\n");

let sourceRoot: string;

beforeAll(() => {
  sourceRoot = mkdtempSync(join(tmpdir(), "reforce-diagnostic-render-"));
  writeFileSync(join(sourceRoot, "order-service.ts"), sourceText, "utf8");
});

afterAll(() => {
  rmSync(sourceRoot, { recursive: true, force: true });
});

// gateway 的类型注解 `PaymentGateway` 在第 2 行（0-based line 1），字符 40..54。
const missingBean: ReportedDiagnostic = {
  code: "MISSING_BEAN",
  severity: "error",
  message: 'No Bean provides "PaymentGateway".',
  sourceSpan: {
    fileId: "order-service.ts",
    start: { line: 1, character: 40 },
    end: { line: 1, character: 54 },
  },
  related: [
    {
      message: "The dependency is declared here.",
      sourceSpan: {
        fileId: "order-service.ts",
        start: { line: 0, character: 13 },
        end: { line: 0, character: 25 },
      },
    },
  ],
  help: 'Register a provider for "PaymentGateway".',
};

function renderHuman(
  diagnostic: ReportedDiagnostic,
  options: { readonly sourceRoot?: string; readonly explainCommand?: string } = {},
): readonly string[] {
  return normalizeTerminalOutput(
    renderDiagnostic(diagnostic, "human", { stream, ...options }),
  ).split("\n");
}

describe("short diagnostic rendering", () => {
  // 这条形状自 #191 起被脚本与断言依赖，逐字钉死。
  test("keeps the single greppable line with a 1-based position", () => {
    expect(renderDiagnostic(missingBean, "short", { stream })).toBe(
      '[MISSING_BEAN] order-service.ts:2:41 No Bean provides "PaymentGateway".',
    );
  });

  test("omits the position when the diagnostic has no span", () => {
    const { sourceSpan: _sourceSpan, ...spanless } = missingBean;
    expect(renderDiagnostic(spanless, "short", { stream })).toBe(
      '[MISSING_BEAN] No Bean provides "PaymentGateway".',
    );
  });
});

describe("json diagnostic rendering", () => {
  test("emits one parseable record carrying the whole diagnostic", () => {
    expect(JSON.parse(renderDiagnostic(missingBean, "json", { stream }))).toEqual({
      kind: "diagnostic",
      ...missingBean,
    });
  });
});

describe("human diagnostic rendering", () => {
  test("underlines exactly the span the diagnostic points at", () => {
    const lines = renderHuman(missingBean, { sourceRoot });

    expect(lines.slice(0, 5)).toEqual([
      'error[MISSING_BEAN]: No Bean provides "PaymentGateway".',
      " --> order-service.ts:2:41",
      "  |",
      "2 |   constructor(private readonly gateway: PaymentGateway) {}",
      `  | ${" ".repeat(40)}^^^^^^^^^^^^^^`,
    ]);
  });

  test("locates every related note", () => {
    const lines = renderHuman(missingBean, { sourceRoot });

    expect(lines).toContain("  = note: The dependency is declared here.");
    expect(lines).toContain("    --> order-service.ts:1:14");
  });

  test("renders help as its own note line", () => {
    expect(renderHuman(missingBean, { sourceRoot })).toContain(
      '  = help: Register a provider for "PaymentGateway".',
    );
  });

  test("prints the long-form pointer only when the caller supplies one", () => {
    const withArticle = renderHuman(missingBean, {
      sourceRoot,
      explainCommand: "reforce explain MISSING_BEAN",
    });
    const withoutArticle = renderHuman(missingBean, { sourceRoot });

    expect(withArticle).toContain("  = 详解: reforce explain MISSING_BEAN");
    expect(withoutArticle.some((line) => line.includes("详解"))).toBe(false);
  });

  // 降级路径：诊断已经是失败路径，渲染再失败就什么都看不到了。
  test("degrades to the position line when no source root is configured", () => {
    expect(renderHuman(missingBean).slice(0, 2)).toEqual([
      'error[MISSING_BEAN]: No Bean provides "PaymentGateway".',
      " --> order-service.ts:2:41",
    ]);
  });

  test("degrades to the position line when the source file cannot be read", () => {
    expect(
      renderHuman(missingBean, { sourceRoot: join(sourceRoot, "absent") }).slice(0, 2),
    ).toEqual([
      'error[MISSING_BEAN]: No Bean provides "PaymentGateway".',
      " --> order-service.ts:2:41",
    ]);
  });

  test("labels a warning as a warning", () => {
    const warning: ReportedDiagnostic = { ...missingBean, severity: "warning", related: [] };

    expect(renderHuman(warning, { sourceRoot })[0]).toBe(
      'warning[MISSING_BEAN]: No Bean provides "PaymentGateway".',
    );
  });
});
