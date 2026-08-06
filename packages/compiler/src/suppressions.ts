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

// 一轮求值：先按当前的 used/notApplicable 展开候选集（含本轮该生成的抑制自身诊断），再让全部
// 抑制去匹配这个候选集，顺带把 used/notApplicable 补齐。
function evaluate(
  input: readonly CompilerDiagnostic[],
  entries: readonly Entry[],
  used: Set<Entry>,
  notApplicable: Set<Entry>,
): readonly CompilerDiagnostic[] {
  const generated = entries
    .filter((entry) => !used.has(entry))
    .map((entry) =>
      notApplicable.has(entry) ? notApplicableDiagnostic(entry) : unusedDiagnostic(entry),
    );
  const kept: CompilerDiagnostic[] = [];
  for (const item of [...input, ...generated]) {
    let suppressed = false;
    for (const entry of entries) {
      if (!matches(item, entry)) {
        continue;
      }
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
  return kept;
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
  // 迭代到不动点，而不是一遍过：UNUSED_SUPPRESSION 与 SUPPRESSION_NOT_APPLICABLE 是本阶段
  // 自己生成的，一遍过意味着它们永远压不掉——而「上面那条抑制暂时留着」正是最常见的写法。
  //
  // used/notApplicable 只增不减，这是收敛的全部理由。换成「每轮重新判定」会在互相指向的两条
  // 抑制上来回震荡：都不 used 时互相压住、都 used 时都不生成，两个状态无限交替。
  const used = new Set<Entry>();
  const notApplicable = new Set<Entry>();
  let output = evaluate(diagnostics, entries, used, notApplicable);
  for (let round = 0; round < entries.length; round += 1) {
    const settled = used.size + notApplicable.size;
    output = evaluate(diagnostics, entries, used, notApplicable);
    if (used.size + notApplicable.size === settled) {
      break;
    }
  }
  return { diagnostics: output };
}
