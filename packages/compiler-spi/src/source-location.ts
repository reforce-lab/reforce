declare const canonicalFileIdBrand: unique symbol;

export type CanonicalFileId = string & {
  readonly [canonicalFileIdBrand]: true;
};

export interface SourcePosition {
  readonly offset: number;
  readonly line: number;
  readonly character: number;
}

export interface SourceSpan {
  readonly fileId: CanonicalFileId;
  readonly start: SourcePosition;
  readonly end: SourcePosition;
}
