import type { CompilerDiagnostic } from "@/api";
import { diagnostic } from "@/diagnostics";
import type { SuppressionComment } from "@/parser/suppressions";

// 抑制的应用（RFC 0011 D7，#242）。
//
// 只对 warning 开放，这不是保守，是可实现性的边界：抑制一条 MISSING_BEAN 意味着
// resolveProviders 根本没为那个构造参数产出依赖边，emission 会照着不完整的分析结果发射实参
// 缺失的 `new X(...)`。命中 error 的抑制注释本身报一条 SUPPRESSION_NOT_APPLICABLE，让写的人
// 知道它没有生效，而不是以为压住了。

export interface SuppressionSource {
  readonly fileId: string;
  readonly suppressions: readonly SuppressionComment[];
}

interface Applied {
  readonly diagnostics: readonly CompilerDiagnostic[];
}

interface Entry {
  readonly fileId: string;
  readonly suppression: SuppressionComment;
}

function matches(item: CompilerDiagnostic, entry: Entry): boolean {
  const span = item.sourceSpan;
  return (
    span !== undefined &&
    span.fileId === entry.fileId &&
    span.start.line === entry.suppression.targetLine &&
    item.code === entry.suppression.code
  );
}

function unusedDiagnostic(entry: Entry): CompilerDiagnostic {
  return diagnostic({
    code: "UNUSED_SUPPRESSION",
    severity: "warning",
    message: `Nothing on the next line reports "${entry.suppression.code}".`,
    sourceSpan: entry.suppression.span,
    help: "A suppression that stops matching is how a stale one gets noticed. Delete it, or move it onto the line that actually reports the code.",
  });
}

function notApplicableDiagnostic(entry: Entry): CompilerDiagnostic {
  return diagnostic({
    code: "SUPPRESSION_NOT_APPLICABLE",
    severity: "warning",
    message: `Suppressing "${entry.suppression.code}" has no effect: it is an error, not a warning.`,
    sourceSpan: entry.suppression.span,
    help: "An error means the analysis could not produce a complete graph, so there is nothing valid to emit past it. Fix what is reported instead of suppressing it.",
  });
}

// 抑制阶段自产的两条诊断**不可被抑制注释压住**。这是设计边界，不是没做完：
//
// 允许压它们，就等于允许「E1 是否 used」取决于「E2 是否 used」，而 E2 的 UNUSED_SUPPRESSION
// 只在 E2 不 used 时才存在——一条带否定的依赖。两条互相指着对方的抑制因此有两个同样自洽的
// 解（都 used、都 unused），选哪个只取决于求值顺序。首版写成不动点迭代，代价是：本轮才被标
// used 的条目，它那条「不该存在」的 UNUSED_SUPPRESSION 已经进了候选集，能把另一条抑制喂成
// used——于是一条彻头彻尾的僵尸抑制永远不报，而这正是 UNUSED_SUPPRESSION 存在的唯一理由。
//
// 要关掉它们用 `--diagnostic-level UNUSED_SUPPRESSION=off`：那是个全局开关，不参与匹配，
// 不构成环。Biome 的 suppression/unused 同样只能按规则开关，不能用抑制注释压。
const unsuppressableCodes: ReadonlySet<string> = new Set([
  "UNUSED_SUPPRESSION",
  "SUPPRESSION_NOT_APPLICABLE",
]);

function selfReferentialDiagnostic(entry: Entry): CompilerDiagnostic {
  return diagnostic({
    code: "SUPPRESSION_NOT_APPLICABLE",
    severity: "warning",
    message: `"${entry.suppression.code}" cannot be suppressed by a comment.`,
    sourceSpan: entry.suppression.span,
    help: `A suppression that could hide its own "unused" report would make staleness undetectable. Turn it off globally with --diagnostic-level ${entry.suppression.code}=off.`,
  });
}

function entryReport(
  entry: Entry,
  used: ReadonlySet<Entry>,
  notApplicable: ReadonlySet<Entry>,
): readonly CompilerDiagnostic[] {
  if (unsuppressableCodes.has(entry.suppression.code)) {
    return [selfReferentialDiagnostic(entry)];
  }
  if (notApplicable.has(entry)) {
    return [notApplicableDiagnostic(entry)];
  }
  return used.has(entry) ? [] : [unusedDiagnostic(entry)];
}

export function applySuppressions(
  diagnostics: readonly CompilerDiagnostic[],
  sources: readonly SuppressionSource[],
): Applied {
  const entries = sources.flatMap((source) =>
    source.suppressions.map((suppression) => ({ fileId: source.fileId, suppression })),
  );
  if (entries.length === 0) {
    return { diagnostics };
  }
  // 一遍过，因为候选集只有真实诊断：自产的两条不参与匹配（见上），所以不存在「压住之后候选集
  // 变了要重算」的情况。
  const used = new Set<Entry>();
  const notApplicable = new Set<Entry>();
  const kept: CompilerDiagnostic[] = [];
  for (const item of diagnostics) {
    let suppressed = false;
    for (const entry of entries) {
      if (unsuppressableCodes.has(entry.suppression.code) || !matches(item, entry)) {
        continue;
      }
      // error 不可抑制：分析没能产出完整的图，往后发射的是实参缺失的构造调用。
      if (item.severity === "error") {
        notApplicable.add(entry);
        continue;
      }
      used.add(entry);
      suppressed = true;
    }
    if (!suppressed) {
      kept.push(item);
    }
  }
  return {
    diagnostics: [...kept, ...entries.flatMap((entry) => entryReport(entry, used, notApplicable))],
  };
}
