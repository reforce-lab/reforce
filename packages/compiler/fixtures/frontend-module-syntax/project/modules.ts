import DefaultValue, * as namespaceValue from "package-a";
import type { Input, Source as RenamedSource } from "package-b";

export { LocalValue, type LocalType };
export { RemoteValue as Value, type RemoteType } from "package-c";
export * from "package-d";
export * as tools from "package-e";
export default DefaultValue;

export namespace Outer {
  export interface Contract {}
  export namespace Inner {
    export const value = namespaceValue;
  }
}

interface LocalType {}
const LocalValue = 1;
type InputAlias = Input;
type SourceAlias = RenamedSource;
