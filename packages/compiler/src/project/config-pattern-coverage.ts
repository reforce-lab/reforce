import path from "node:path";
import { toPortablePath } from "@reforce/primitives";
import { createFilesMatcher, type TsConfigJsonResolved } from "get-tsconfig";
import { generatedDeclarationsPath } from "@/project/generated-paths";

// UNC roots ("//server/share") rely on patches/get-tsconfig@4.14.1.patch, which carries the
// upstream fix for privatenumber/get-tsconfig#133 (PR #134): without it every relative
// include/files entry misses under a UNC project. Drop the patch when a get-tsconfig release
// contains the fix; Issue #72 records the removal conditions.

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
  const configPath = toPortablePath(tsconfigPath);
  const matchFile = createFilesMatcher({ config, path: configPath });
  const declarations = `${path.posix.dirname(configPath)}/${generatedDeclarationsPath}`;
  // A miss is `undefined`, not `null`; comparing against `null` would make this always true.
  return matchFile(declarations) !== undefined;
}
