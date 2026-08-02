export interface AstNode {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [key: string]: unknown;
}

export function isAstNode(value: unknown): value is AstNode {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string" &&
    "start" in value &&
    typeof value.start === "number" &&
    "end" in value &&
    typeof value.end === "number"
  );
}

export function nodeProperty(node: AstNode, key: string): AstNode | undefined {
  const value = node[key];
  return isAstNode(value) ? value : undefined;
}

export function nodeArrayProperty(node: AstNode, key: string): readonly AstNode[] {
  const value = node[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isAstNode);
}

export function stringProperty(node: AstNode, key: string): string | undefined {
  const value = node[key];
  return typeof value === "string" ? value : undefined;
}

export function booleanProperty(node: AstNode, key: string): boolean {
  return node[key] === true;
}

export function hasItems(node: AstNode, key: string): boolean {
  const value = node[key];
  return Array.isArray(value) && value.length > 0;
}
