import path from "node:path";
import { toPortablePath } from "@reforce/primitives";
import { createFilesMatcher, type TsConfigJsonResolved } from "get-tsconfig";
import { generatedDeclarationsPath } from "@/project/generated-paths";

// get-tsconfig resolves the config's relative include/files entries with path.posix.join, which
// collapses the leading "//" of a UNC path, yet matches them against a file path that still has
// both slashes — so on a UNC project every relative entry misses and the diagnostic fires on a
// perfectly good tsconfig. Drop one leading slash on both sides so the two agree again. Absolute
// entries written inside a UNC tsconfig stay unmatched, which is what the previous hand-rolled
// matcher did too. Drive-letter paths have no "//" prefix and pass through untouched.
// Delete this once get-tsconfig ships a fix; Issue #72 records the removal conditions, upstream
// is privatenumber/get-tsconfig#133.
function matchablePath(portablePath: string): string {
  return portablePath.startsWith("//") ? portablePath.slice(1) : portablePath;
}

/**
 * Whether tsc would pull `.reforce/generated/qualifiers.d.ts` into the compilation unit.
 *
 * A wildcard segment in a tsconfig `include` never matches a name that starts with a dot — tsc
 * expands `*` to `([^./]|(\.(?!min\.js$))?)*`. So `include` values like `**\/*`, `.` and
 * `**\/*.d.ts` all stop short of `.reforce/`, and the declarations only arrive when the config
 * names that path explicitly. A hand-written glob matcher did not know that rule and answered
 * "included" for those patterns, which kept GENERATED_DECLARATIONS_NOT_INCLUDED silent while the
 * user's own tsc failed on missing qualifier types (Issue #60). get-tsconfig reproduces the rule,
 * so defer to it instead of maintaining a second copy of tsc's matching semantics.
 *
 * `config` must already have its `extends` chain resolved (a `parseTsconfig` result); a config
 * that still carries `extends` makes the matcher throw.
 */
export function generatedDeclarationsAreIncluded(
  config: TsConfigJsonResolved,
  tsconfigPath: string,
): boolean {
  const configPath = matchablePath(toPortablePath(tsconfigPath));
  const matchFile = createFilesMatcher({ config, path: configPath });
  const declarations = `${path.posix.dirname(configPath)}/${generatedDeclarationsPath}`;
  // A miss is `undefined`, not `null`; comparing against `null` would make this always true.
  return matchFile(declarations) !== undefined;
}
