import path from "node:path";

function runtimeSuffix(file: string): string {
  if (file.endsWith(".d.mts")) {
    return `${file.slice(0, -6)}.mjs`;
  }
  if (file.endsWith(".d.cts")) {
    return `${file.slice(0, -6)}.cjs`;
  }
  if (file.endsWith(".d.ts")) {
    return `${file.slice(0, -5)}.js`;
  }
  if (file.endsWith(".mts")) {
    return `${file.slice(0, -4)}.mjs`;
  }
  if (file.endsWith(".cts")) {
    return `${file.slice(0, -4)}.cjs`;
  }
  if (file.endsWith(".tsx")) {
    return `${file.slice(0, -4)}.js`;
  }
  return file.endsWith(".ts") ? `${file.slice(0, -3)}.js` : file;
}

export function renderRuntimeSpecifier(generatedDirectory: string, sourceFile: string): string {
  const relative = path.relative(generatedDirectory, sourceFile).split(path.sep).join("/");
  const withPrefix = relative.startsWith(".") ? relative : `./${relative}`;
  return runtimeSuffix(withPrefix);
}
