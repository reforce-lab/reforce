import {
  isIdentifierName,
  isKeyword,
  isStrictReservedWord,
} from "@babel/helper-validator-identifier";

export function validQualifierName(name: string): boolean {
  return isIdentifierName(name) && !isKeyword(name) && !isStrictReservedWord(name, true);
}
