import { runTransactionTck } from "@/run";
import { memoryHarness } from "./support/memory-manager";

// 参考实现跑完整套 TCK：本包对外承诺的入口（runTransactionTck）在真实 Vitest 报告里的样子，
// 同时是 adapter 作者的用法示例。
runTransactionTck(memoryHarness());
