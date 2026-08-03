// analysis 单元测试共用的 source-location 构造器（Issue #27）。
// 这里只收录四个 analysis spec 里逐字重复的部分：文件标识的不透明转换，以及"一个 span 占
// offset..offset+1、恒定落在第 0 行"这条测试约定。符号与 linker 桩各 spec 需要的解析策略不同，
// 仍留在各自 spec 内。
import type { CanonicalFileId, SourceSpan } from "@/parser/source-location";

export function canonicalFileId(file: string): CanonicalFileId {
  return file as CanonicalFileId; // Production analysis receives this opaque identity from source discovery.
}

export function span(file: string, offset = 0): SourceSpan {
  return {
    fileId: canonicalFileId(file),
    start: { offset, line: 0, character: offset },
    end: { offset: offset + 1, line: 0, character: offset + 1 },
  };
}
