import type { Comment } from "yuku-parser";
import { normalizeSpanned } from "@/parser/normalize";
import type { CanonicalFileId, SourceMapper, SourceSpan } from "@/parser/source-location";

// 抑制注释（RFC 0011 D7，#242）：`// reforce-ignore <CODE>: <explanation>`，作用于下一行。
//
// explanation 是语法的一部分（照 Biome）：抑制是一条长期承诺，写下它的人必须留下为什么。
// 只认行注释，不认块注释——块注释可以横跨多行、也可以嵌在表达式中间，「作用于下一行」在
// 那些位置上没有确定含义。
//
// 注释从 parse 结果的平铺 comments 列表读，与 attachComments 无关（实测两种取值下 comments
// 完全相同，且都带 UTF-16 offset，与 createSourceMapper 同单位）。attachComments: true 给的
// AttachedComment 反而没有 offset，比 false 更不可用，所以那个开关保持原样。
export interface SuppressionComment {
  readonly kind: "suppression";
  readonly code: string;
  readonly explanation: string;
  /** 注释自身的位置，UNUSED_SUPPRESSION 靠它定位。 */
  readonly span: SourceSpan;
  /** 被抑制的那一行（0-based），即注释所在行的下一行。 */
  readonly targetLine: number;
}

const suppressionPattern = /^\s*reforce-ignore\s+([A-Z][A-Z0-9_]*)\s*:\s*(\S.*?)\s*$/u;

// 行首非代码位：注释前面只能是空白。`doSomething(); // reforce-ignore X: y` 里的注释属于
// 这一行的代码，把它读成「抑制下一行」会让作用范围与写的人想的差一行。
function startsItsOwnLine(sourceText: string, start: number): boolean {
  for (let offset = start - 1; offset >= 0; offset -= 1) {
    const character = sourceText[offset];
    if (character === "\n" || character === "\r") {
      return true;
    }
    if (character !== " " && character !== "\t") {
      return false;
    }
  }
  return true;
}

export function collectSuppressions(input: {
  readonly file: CanonicalFileId;
  readonly sourceText: string;
  readonly comments: readonly Comment[];
  readonly mapper: SourceMapper;
}): readonly SuppressionComment[] {
  const suppressions: SuppressionComment[] = [];
  for (const comment of input.comments) {
    if (comment.type !== "Line") {
      continue;
    }
    const match = suppressionPattern.exec(comment.value);
    const code = match?.[1];
    const explanation = match?.[2];
    if (code === undefined || explanation === undefined) {
      continue;
    }
    if (!startsItsOwnLine(input.sourceText, comment.start)) {
      continue;
    }
    const span = input.mapper.span(comment.start, comment.end);
    suppressions.push({
      kind: "suppression",
      code,
      explanation,
      span,
      targetLine: span.start.line + 1,
    });
  }
  return normalizeSpanned(suppressions);
}
