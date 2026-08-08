import { parseStarterMeta, type StarterMetaSymbol, starterMetaSubpath } from "@/meta";

// starter 包的静态体检（#369）：parse 只回答「这份字节合不合 schema」，而作者真正会犯的错在
// 字节之外——meta 没挂进 exports、符号指向一个没随包发布的 .d.ts、subpath 压根不在 exports 里。
// 这三样在应用侧只会表现为「装了 starter 却没接上」，作者本地零信号。
//
// 本模块**不碰 fs**：路径是否存在由调用方注入。`reforce-meta-check`（本包 bin）与
// `reforce meta check`（@reforce/cli）因此共用同一份判定，不会各自漂。

export interface StarterPackageProblem {
  /** error 会让检查失败；warning 只是说「诊断质量会退化」，不阻断。 */
  readonly severity: "error" | "warning";
  readonly message: string;
}

export interface StarterPackageCheckInput {
  /** 已解析的 package.json 字节。 */
  readonly packageJson: unknown;
  /** 已解析的 reforce-meta.json 字节。 */
  readonly meta: unknown;
  /**
   * 包内相对路径在包根下是否存在。对装好的（或 `npm pack` 出来的）包，这就是「随包发布」；
   * 在作者的工作区里它是超集——工作区有而发布没有的文件在这里查不出来。
   */
  readonly fileExists: (packageRelativePath: string) => boolean;
}

const metaTarget = `.${starterMetaSubpath.slice(1)}.json`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 接受 exports 的两种直写形态：字符串目标，或 default 条件指向目标的条件对象。其余形态
// （pattern、数组 fallback、深嵌条件）解析结果依赖包管理器语义，一律要求作者改成直写。
function subpathReaches(target: unknown, expected: string): boolean {
  if (typeof target === "string") {
    return target === expected;
  }
  return isRecord(target) && target.default === expected;
}

function subpathDeclared(exports: Record<string, unknown>, subpath: string): boolean {
  return Reflect.has(exports, subpath);
}

/**
 * exports 是 starter 与读者之间唯一的接线口：meta 挂不上去，应用侧连找都找不到它。
 *
 * 返回 undefined 表示没问题。给 `reforce lib` 用同一份判定——它在**写盘之前**跑这个，
 * 免得作者拿到一份写好了却接不上的产物。
 */
export function findExportsProblem(packageJson: unknown): string | undefined {
  const exports = isRecord(packageJson) ? packageJson.exports : undefined;
  if (!isRecord(exports)) {
    return "package.json must declare an exports map.";
  }
  return subpathReaches(exports[starterMetaSubpath], metaTarget)
    ? undefined
    : `exports must map "${starterMetaSubpath}" to "${metaTarget}".`;
}

function packageNameOf(packageJson: unknown): string | undefined {
  const name = isRecord(packageJson) ? packageJson.name : undefined;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

function parseFailureMessage(
  result: Exclude<ReturnType<typeof parseStarterMeta>, { readonly status: "success" }>,
): string {
  if (result.status === "invalid") {
    return result.reason;
  }
  if (result.status === "unsupported-version") {
    return `schemaVersion ${result.foundVersion} is not one this checker knows.`;
  }
  return `requires names capabilities this checker does not know: ${result.required.join(", ")}.`;
}

export function checkStarterPackage(
  input: StarterPackageCheckInput,
): readonly StarterPackageProblem[] {
  const packageName = packageNameOf(input.packageJson);
  if (packageName === undefined) {
    return [{ severity: "error", message: "package.json must declare a name." }];
  }
  const problems: StarterPackageProblem[] = [];
  const exportsProblem = findExportsProblem(input.packageJson);
  if (exportsProblem !== undefined) {
    problems.push({ severity: "error", message: exportsProblem });
  }
  const parsed = parseStarterMeta(input.meta, packageName);
  if (parsed.status !== "success") {
    problems.push({ severity: "error", message: parseFailureMessage(parsed) });
    // 字节没过闸门时，下面按 symbols/beans 逐条查等于对着一份不可信的结构报错。
    return problems;
  }
  const exports = isRecord(input.packageJson) ? input.packageJson.exports : undefined;
  problems.push(...symbolProblems(parsed.meta.symbols, exports, input.fileExists));
  // 源码不随包发布是常态（`files: ["dist", "reforce-meta.json"]`），所以这条只是 warning：
  // 代价是应用侧诊断少一行代码框，接线本身完好。
  for (const bean of parsed.meta.beans) {
    if (bean.source !== undefined && !input.fileExists(bean.source.file)) {
      problems.push({
        severity: "warning",
        message: `${bean.id} points at ${bean.source.file}, which is not in the package; diagnostics about this bean will lose their code frame.`,
      });
    }
  }
  return problems;
}

// 户口表的两条：锚点文件必须随包发布，声称的 subpath 必须真的在 exports 里。两者都是「应用侧
// 找不到这个符号」的同一个后果，所以合在一起看。
function symbolProblems(
  symbols: readonly StarterMetaSymbol[],
  exports: unknown,
  fileExists: StarterPackageCheckInput["fileExists"],
): readonly StarterPackageProblem[] {
  const problems: StarterPackageProblem[] = [];
  for (const symbol of symbols) {
    if (!fileExists(symbol.file)) {
      problems.push({
        severity: "error",
        message: `${symbol.id} is anchored to ${symbol.file}, which is not in the package.`,
      });
    }
    const missing = isRecord(exports)
      ? symbol.subpaths.filter((subpath) => !subpathDeclared(exports, subpath))
      : [];
    for (const subpath of missing) {
      problems.push({
        severity: "error",
        message: `${symbol.id} claims subpath "${subpath}", which package.json exports does not declare.`,
      });
    }
  }
  return problems;
}
