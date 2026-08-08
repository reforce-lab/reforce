import type { ProviderDraft, ProviderModel } from "@/analysis/model";
import type { PassChannels } from "@/analysis/pass-channels";
import type { CompilerDiagnostic } from "@/api";
import type { ProjectLinker } from "@/linking/project-linker";
import type { ParsedSource } from "@/project/source-files";
import type { TypeQuery } from "@/typescript/type-query";

// 编译器内部 pass 架构（#344 定案）。
//
// analyzeProject 的时序此前是 12 步手插，每一步的排序理由只活在注释里。这里把它归纳成
// 「3 个 pass 相位 + 3 个固定核心步」：
//
//   1 validateModuleSyntax        主干，无域
//   2 discover                    相位：只吃 (sources, linker)，产 draft、写通道
//   3 collectProviderDrafts       核心：读 claimedDeclarations
//   4 contribute                  相位：吃全量 draft + 读通道，产 draft、写通道
//   5 resolveProviders → 排序 → validateScopeRules
//                                 核心：读 demandedBeanIds、resolutionOverrides
//   6 refine                      相位：吃全量 provider + 读通道，产领域 model
//   7 createExecutionPlans        核心
//
// 为什么是 3 个相位而不是「pre-resolve / post-resolve」两个：`collectProviderDrafts` 这个核心
// 步把 pre-resolve 劈成两半——config 的认领必须在它之前写完，而框架 logger 的需求要看全部
// draft 才知道全貌，只能在它之后。
//
// **一个领域可以注册多个 pass**：web 因此拆成 web-engine（discover，只做引擎探测）与
// web-routes（refine）。这样「一个 pass 只属于一个相位」成立，不必引入跨相位 pass。

export interface PassContext {
  readonly sources: readonly ParsedSource[];
  readonly linker: ProjectLinker;
  readonly diagnostics: CompilerDiagnostic[];
  readonly typeQuery: TypeQuery | undefined;
}

/**
 * pass 声明自己读写哪些通道键，**不声明 pass 名**。
 *
 * 声明 pass 名会让注册表变成一张要拓扑排序的图；通道键说的是「我要什么数据」，与谁产出它
 * 解耦，而顺序正确性由 `channelOrderProblems` 在注册表上静态核实。
 *
 * 刻意不加 `dependsOn` / `priority` / `enabled`：这三样都是「将来可能用到」的口子（YAGNI）。
 */
interface PassBase {
  readonly name: string;
  readonly reads: readonly (keyof PassChannels)[];
  readonly writes: readonly (keyof PassChannels)[];
}

export interface DiscoverPass extends PassBase {
  readonly phase: "discover";
  run(context: PassContext, out: PassChannels): readonly ProviderDraft[];
}

export interface ContributePass extends PassBase {
  readonly phase: "contribute";
  run(
    context: PassContext,
    drafts: readonly ProviderDraft[],
    out: PassChannels,
  ): readonly ProviderDraft[];
}

/**
 * refine 相位的契约里有一条今天只活在注释里的不变量，必须在这里写死：**追加
 * `provider.dependencies` 边只允许 singleton → singleton**。`validateScopeRules` 在相位之前
 * 就跑完了，refine 追加的边不再受它检查。
 *
 * 定案 5 的 `emit(model, target)` 不在这里：`analysis` 不能 import `emission`（今天是
 * emission 单向依赖 analysis），把 emitter 挂进本文件会把依赖方向拧过来。model → 文件的配对
 * 落在 emission 侧按 pass 名索引，随第一个 refine pass（步 6）一起进来。
 */
export interface RefinePass<M> extends PassBase {
  readonly phase: "refine";
  run(context: PassContext, providers: readonly ProviderModel[], out: PassChannels): M;
}

export type AnalysisPass = DiscoverPass | ContributePass | RefinePass<unknown>;

/**
 * 注册表：`as const` 数组字面量，**执行序即下标序**。
 *
 * 禁止按名字或包名动态排序，禁止迭代 Map 决定顺序——那样两次编译的 pass 顺序就不再由源码
 * 唯一决定，而生成物逐字节可复现这条不变量正建立在它之上。
 */
export type PassRegistry = readonly AnalysisPass[];

export function runDiscoverPasses(
  registry: PassRegistry,
  context: PassContext,
  channels: PassChannels,
): readonly ProviderDraft[] {
  const drafts: ProviderDraft[] = [];
  for (const pass of registry) {
    if (pass.phase === "discover") {
      drafts.push(...pass.run(context, channels));
    }
  }
  return drafts;
}

export function runContributePasses(
  registry: PassRegistry,
  context: PassContext,
  drafts: readonly ProviderDraft[],
  channels: PassChannels,
): readonly ProviderDraft[] {
  // 逐个累积而不是先收集再 flatMap：contribute 的输入契约是「全量 draft」，前一个 pass 贡献的
  // draft 对后一个必须可见（logging 要看得见事务拦截器那条 draft 的 pendingDependencies）。
  let accumulated = drafts;
  for (const pass of registry) {
    if (pass.phase === "contribute") {
      accumulated = [...accumulated, ...pass.run(context, accumulated, channels)];
    }
  }
  return accumulated;
}

/** 注册表序与通道拓扑不一致的地方（断言 A 的实现，spec 断言它为空）。 */
export function channelOrderProblems(registry: PassRegistry): readonly string[] {
  const lastWriter = new Map<keyof PassChannels, number>();
  for (const [index, pass] of registry.entries()) {
    for (const channel of pass.writes) {
      lastWriter.set(channel, Math.max(lastWriter.get(channel) ?? -1, index));
    }
  }
  const problems: string[] = [];
  for (const [index, pass] of registry.entries()) {
    for (const channel of pass.reads) {
      const writer = lastWriter.get(channel);
      if (writer !== undefined && writer > index) {
        problems.push(
          `${pass.name} reads ${channel} at index ${index} but ${registry[writer]?.name} writes it at index ${writer}`,
        );
      }
    }
  }
  return problems;
}
