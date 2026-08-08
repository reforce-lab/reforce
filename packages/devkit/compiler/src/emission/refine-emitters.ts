import type { WeavingModel } from "@/analysis/interception-model";
import type { RefinePassName } from "@/analysis/pass-registry";
import type { WebModel } from "@/analysis/web-model";
import type { GeneratedFile, ResolvedApplicationProject } from "@/api";
import { generateWeavingFile } from "@/emission/generate-weaving-file";
import { generateWebFiles } from "@/emission/generate-web-files";

// refine pass 与它产出的文件的配对表（#344 定案 5）。
//
// 它落在 **emission 侧**而不是 `RefinePass` 声明上：今天是 emission 单向依赖 analysis，把
// emitter 挂进 pass 声明会把依赖方向拧过来。代价是配对关系写在两处，收益是依赖图不变——所以
// 「有没有漏配」必须是可检查的，而不是靠人记得。
//
// 穷举由类型系统守：键类型是 `RefinePassName`（从注册表里 phase 为 refine 的成员的 name 推
// 出来的字面量联合），`satisfies Record<RefinePassName, RefineEmitter>` 因此要求一个不缺。
// 加一个 refine pass 而不给它配 emitter，这一行当场红。
//
// 注意这**不是**「model → 文件」的全部真相：`renderBeans` 也消费 weaving（织入表要嵌进
// beans.ts 的构造调用），所以 `AnalysisSuccess.weaving` 仍是具名字段，不能假装 weaving 只经
// 由这张表流出去。定案 5 把这条叫「半配对」。

interface RefineEmitterInput {
  readonly project: ResolvedApplicationProject;
  readonly web: WebModel;
  readonly weaving: WeavingModel;
}

type RefineEmitter = (input: RefineEmitterInput) => readonly GeneratedFile[];

const refineEmitters = {
  "web-routes": (input) => generateWebFiles(input.project, input.web),
  "method-interception": (input) => [generateWeavingFile(input.weaving)],
} as const satisfies Record<RefinePassName, RefineEmitter>;

/**
 * 全部 refine pass 的产出文件，按配对表的键序。
 *
 * 键序即源码序，与注册表下标序无关也不需要有关：这些文件各自独立，`generateFiles` 最后
 * `Object.freeze` 出来的数组顺序才是产物顺序，而它由本文件的字面量固定，两次编译逐字节相同。
 */
export function refineGeneratedFiles(input: RefineEmitterInput): readonly GeneratedFile[] {
  return Object.values(refineEmitters).flatMap((emit) => emit(input));
}
