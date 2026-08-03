import path from "node:path";

// All knowledge of where compiler-generated output lives: every "is this the generated directory"
// check and every reference to the generated declarations derives from these constants, so
// renaming the output layout stays a single-point change.
const generatedDirectory = ".reforce/generated";
const generatedDeclarationsEntry = "qualifiers.d.ts";

/** Portable project-relative path of the generated qualifiers declarations. */
export const generatedDeclarationsPath = `${generatedDirectory}/${generatedDeclarationsEntry}`;

/** Substring that recognizes generated output inside an already-portable absolute path. */
export const generatedDirectoryFragment = `/${generatedDirectory}/`;

/** Absolute path of the directory that receives compiler-generated files. */
export function generatedDirectoryPath(projectRoot: string): string {
  return path.join(projectRoot, ...generatedDirectory.split("/"));
}

export function generatedDeclarationsFile(projectRoot: string): string {
  return path.join(projectRoot, ...generatedDirectory.split("/"), generatedDeclarationsEntry);
}
