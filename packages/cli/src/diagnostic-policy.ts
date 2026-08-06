import type { CompilerDiagnostic } from "@reforce/compiler";

// 诊断级别策略（RFC 0011 D7.1，#242）。对位 rustc 的 -A/-W/-D：级别走 CLI flag，不新造项目级
// 配置面——本仓 tsconfig 之外没有配置面，为调级新建一个是另一个独立主题。
//
// **只能作用于 warning。** 把 error 调成 warn 或 off 是不可实现的：error 意味着分析没能产出
// 完整的 provider 图，继续发射会生成实参缺失的构造调用。这与抑制注释只对 warning 开放是
// 同一条理由（见 compiler 的 suppressions.ts）。
export type DiagnosticLevel = "off" | "warn" | "error";

export interface DiagnosticPolicy {
  readonly denyWarnings: boolean;
  readonly levels: ReadonlyMap<string, DiagnosticLevel>;
}

export const permissiveDiagnosticPolicy: DiagnosticPolicy = {
  denyWarnings: false,
  levels: new Map(),
};

const levelByName = new Map<string, DiagnosticLevel>([
  ["off", "off"],
  ["warn", "warn"],
  ["error", "error"],
]);

export const diagnosticLevelNames: readonly string[] = [...levelByName.keys()];

export class DiagnosticLevelSyntaxError extends Error {}

export function parseDiagnosticLevels(
  values: readonly string[],
): ReadonlyMap<string, DiagnosticLevel> {
  const levels = new Map<string, DiagnosticLevel>();
  for (const value of values) {
    const separator = value.indexOf("=");
    const code = separator < 0 ? "" : value.slice(0, separator);
    const level = levelByName.get(value.slice(separator + 1));
    if (code.length === 0 || level === undefined) {
      throw new DiagnosticLevelSyntaxError(
        `--diagnostic-level expects <CODE>=<${diagnosticLevelNames.join("|")}>, received "${value}".`,
      );
    }
    // 后写覆盖先写：同一个码给两次时，命令行上靠后的那次是用户最后的意思。
    levels.set(code, level);
  }
  return levels;
}

export function applyDiagnosticPolicy(
  policy: DiagnosticPolicy,
  diagnostics: readonly CompilerDiagnostic[],
): readonly CompilerDiagnostic[] {
  if (policy.levels.size === 0) {
    return diagnostics;
  }
  const kept: CompilerDiagnostic[] = [];
  for (const item of diagnostics) {
    const level = item.severity === "warning" ? policy.levels.get(item.code) : undefined;
    if (level === "off") {
      continue;
    }
    kept.push(level === "error" ? { ...item, severity: "error" } : item);
  }
  return kept;
}

// 调级后的 error 与 --deny-warnings 都只改退出码，不回收已落盘的生成物：走到这一步说明图是
// 完整的，产物有效，非零退出是给 CI 的闸门信号而不是「构建失败」。
export function deniedByDiagnosticPolicy(
  policy: DiagnosticPolicy,
  diagnostics: readonly CompilerDiagnostic[],
): boolean {
  if (diagnostics.some((item) => item.severity === "error")) {
    return true;
  }
  return policy.denyWarnings && diagnostics.length > 0;
}
