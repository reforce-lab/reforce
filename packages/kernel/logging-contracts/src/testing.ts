// 仅测试用的复位口，刻意不从包主入口导出（照 @reforce/logging/conformance 的先例）。
//
// 应用代码调一次 resetBootstrapRegistryForTest，就会把尚未重放的引导记录整批丢掉——而那批
// 记录在绑定构造失败时是唯一的现场。一句「仅测试用」的注释拦不住误用，换一个 subpath 可以。
export { resetBootstrapRegistryForTest } from "@/bootstrap-registry";
