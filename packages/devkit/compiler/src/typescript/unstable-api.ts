// typescript/unstable/* 的唯一 import 口(RFC 0012 S1,#273):nightly 的 unstable 入口没有稳定性
// 承诺,7.1 正式 API 定稿或入口路径变化时只允许改动本文件,其余模块一律经由这里的 re-export 消费。

export type {
  APIOptions,
  IndexInfo as TsIndexInfo,
  Signature as TsSignature,
  SourceFileMetadata as TsSourceFileMetadata,
  Symbol as TsSymbol,
  Type as TsType,
  TypeReference as TsTypeReference,
} from "typescript/unstable/sync";
export { API, SymbolFlags, TypeFlags } from "typescript/unstable/sync";
