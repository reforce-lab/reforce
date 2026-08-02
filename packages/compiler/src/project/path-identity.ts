import path from "node:path";

type PathSemantics = Pick<typeof path, "isAbsolute" | "relative" | "sep">;

export function isPathContained(
  boundary: string,
  target: string,
  semantics: PathSemantics = path,
): boolean {
  const relative = semantics.relative(boundary, target);
  if (relative === "") {
    return true;
  }
  return (
    relative !== ".." &&
    !relative.startsWith(`..${semantics.sep}`) &&
    !semantics.isAbsolute(relative)
  );
}

export function toPortablePath(nativePath: string): string {
  return nativePath.split(path.sep).join("/");
}
