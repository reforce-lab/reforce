import path from "node:path";
import { toPortablePath } from "@reforce/primitives";
import { createFilesMatcher, type TsConfigJsonResolved } from "get-tsconfig";
import { generatedDeclarationsPath, generatedModulePath } from "@/project/generated-paths";

// UNC roots ("//server/share") rely on patches/get-tsconfig@4.14.1.patch, which carries the
// upstream fix for privatenumber/get-tsconfig#133 (PR #134): without it every relative
// include/files entry misses under a UNC project. Drop the patch when a get-tsconfig release
// contains the fix; Issue #72 records the removal conditions.

/**
 * Whether tsc would pull the generated output — `qualifiers.d.ts` and the emitted modules such as
 * `beans.ts` — into the compilation unit.
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
export function generatedOutputIsIncluded(
  config: TsConfigJsonResolved,
  tsconfigPath: string,
): boolean {
  const configPath = toPortablePath(tsconfigPath);
  const matchFile = createFilesMatcher({ config, path: configPath });
  const projectDirectory = path.posix.dirname(configPath);
  // A miss is `undefined`, not `null`; comparing against `null` would make this always true.
  // 两个探针分别代表生成物的两类文件：只写 `**/*.d.ts` 的 include 覆盖得住 qualifiers、
  // 覆盖不住 beans.ts，而后者才是 emission 缺陷现形的地方（#350）。
  return [generatedDeclarationsPath, generatedModulePath].every(
    (entry) => matchFile(`${projectDirectory}/${entry}`) !== undefined,
  );
}
