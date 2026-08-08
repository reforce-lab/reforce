// 生成物与 meta 共用的位置引用（原 compiler 的 analysis/model.ts，随 #369 搬进契约包）：
// file 是**包内相对 posix 路径**，start/end 是零基的 offset/line/character。
//
// 纯结构类型，没有任何编译器内部依赖——它随 meta 一起成为公开契约的一部分，所以住在这里而
// 不是留在编译器里让契约包反向 import。
export interface SourcePositionModel {
  readonly offset: number;
  readonly line: number;
  readonly character: number;
}

export interface SourceReferenceModel {
  readonly file: string;
  readonly start: SourcePositionModel;
  readonly end: SourcePositionModel;
}
