import { analyzeConfigProviders } from "@/analysis/config-provider";
import type { DiscoverPass, PassRegistry } from "@/analysis/pass";

// pass 注册表（#344 定案 4）：`as const` 数组字面量，**执行序即下标序**。
//
// 禁止按名字或包名动态排序、禁止迭代 Map 决定顺序——那样两次编译的 pass 顺序就不再由源码
// 唯一决定，而「生成物逐字节可复现」这条不变量正建立在它之上。顺序的正确性由
// `test/analysis/pass-registry.spec.ts` 的断言 A（每条通道的 reader 下标 > writer 下标）
// 静态核实，不靠人记住。
//
// 迁移顺序按定案的实施路径走，config 是第一个：347 行、纯 discover、只输出 claimed + drafts、
// 零通道读，是唯一能在不触碰任何时序注释的前提下搬完的 pass。

const configPass: DiscoverPass = {
  name: "config",
  phase: "discover",
  reads: [],
  writes: ["claimedDeclarations"],
  run(context, out) {
    const analysis = analyzeConfigProviders(context.sources, context.linker, context.diagnostics);
    for (const declaration of analysis.claimed) {
      out.claimedDeclarations.add(declaration);
    }
    return analysis.drafts;
  },
};

export const analysisPasses = [configPass] as const satisfies PassRegistry;
