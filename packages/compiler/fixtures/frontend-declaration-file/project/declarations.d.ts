export interface ExternalPort<T> extends Iterable<T> {}

export declare namespace ExternalTokens {
  export interface Qualified {}
}

export declare abstract class ExternalBase<T> implements ExternalPort<T> {
  protected constructor(value: T);
  abstract read(): T;
}
