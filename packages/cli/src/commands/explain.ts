import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  captureFailure,
  createFailureEvent,
  type Reporter,
  reportShutdownFailure,
} from "@reforce/runtime/reporter";
import {
  diagnosticArticle,
  looksLikeDiagnosticCode,
  renderDiagnosticArticle,
  unwrittenArticleIssueUrl,
} from "@/explain/codes";
import { renderExplanation } from "@/explain/render";
import {
  isRouteQuery,
  knownRouteList,
  matchRoutes,
  parseRouteManifestBytes,
  parseRouteQuery,
  type RouteManifest,
  renderRouteExplanation,
  renderRouteOverview,
} from "@/explain/routes";
import { explainContracts } from "@/explain/selection";
import { discoverInstalledStarters } from "@/explain/starter-metas";
import {
  type GeneratedWeavingTable,
  parseGeneratedWeavingBytes,
  wovenMethodsOf,
} from "@/explain/weaving";
import { isMissingPathError } from "@/project/fs-error";
import {
  type GeneratedManifest,
  type ManifestBean,
  parseGeneratedManifestBytes,
  starterOriginPackageName,
} from "@/project/generated-manifest";

// reforce explain <bean> 最小版（ADR 0004 决策 16，#120/#148）：只读生成物（manifest）与磁盘上
// 已安装 starter 的 meta，静态输出选择链——谁提供、为何胜出、谁让位、origin，以及决策 10 多版本
// 撕裂的引入链。不运行编译器；manifest 是唯一的图真相，meta 只补充「让位者」与包布局信息。
// 选择链本身写到 stdout（这是命令的产出），状态与失败仍走 reporter（stderr），两个流可分开消费。

export interface ExplainCommandOptions {
  readonly cwd: string;
  readonly projectDirectory: string;
  readonly beanName: string;
  readonly reporter: Reporter;
  /** 注入以便测试捕获 stdout 产出；生产缺省直接写 process.stdout。 */
  readonly writeOutput?: (line: string) => void;
}

// 三级匹配，取首个非空层：完整 bean id > 导出名 > 契约 displayName。前两层是 manifest 的
// 线上标识，第三层容纳「用户只记得接口名」的场景。
function matchBeans(manifest: GeneratedManifest, query: string): readonly ManifestBean[] {
  const byId = manifest.beans.filter((bean) => bean.id === query);
  if (byId.length > 0) {
    return byId;
  }
  const byExportName = manifest.beans.filter((bean) => bean.id.endsWith(`#${query}`));
  if (byExportName.length > 0) {
    return byExportName;
  }
  return manifest.beans.filter((bean) =>
    bean.provides.some((provided) => provided.displayName === query),
  );
}

function starterPackageNames(manifest: GeneratedManifest): readonly string[] {
  const names = new Set<string>();
  for (const bean of manifest.beans) {
    if (bean.origin === "application") {
      continue;
    }
    const packageName = starterOriginPackageName(bean.origin);
    if (packageName !== undefined) {
      names.add(packageName);
    }
  }
  return [...names];
}

async function readManifest(
  manifestPath: string,
): Promise<{ readonly manifest?: GeneratedManifest; readonly problem?: string }> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(manifestPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return {
        problem: `No generated manifest at ${manifestPath}. Run reforce build or reforce dev first.`,
      };
    }
    throw error;
  }
  const manifest = parseGeneratedManifestBytes(bytes);
  if (manifest === undefined) {
    return {
      problem: `The generated manifest at ${manifestPath} is not valid. Rebuild the application.`,
    };
  }
  return { manifest };
}

// weaving.json 与 manifest 同为无条件生成物（AM1 起）：缺失或非法与 manifest 同级处理，
// 不静默降级成"无织入信息"的输出（#204 定案 7）。
async function readWeaving(
  weavingPath: string,
): Promise<{ readonly weaving?: GeneratedWeavingTable; readonly problem?: string }> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(weavingPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return {
        problem: `No generated weaving table at ${weavingPath}. Run reforce build or reforce dev first.`,
      };
    }
    throw error;
  }
  const weaving = parseGeneratedWeavingBytes(bytes);
  if (weaving === undefined) {
    return {
      problem: `The generated weaving table at ${weavingPath} is not valid. Rebuild the application.`,
    };
  }
  return { weaving };
}

type ExplainOutcome =
  | { readonly kind: "lines"; readonly lines: readonly string[] }
  | {
      readonly kind: "problem";
      readonly phase: "project" | "argv";
      readonly code: "ARTIFACT_INVALID" | "CLI_USAGE_ERROR";
      readonly message: string;
    };

function beanLookupProblem(
  manifest: GeneratedManifest,
  beanName: string,
  matches: readonly ManifestBean[],
): ExplainOutcome {
  // 走到这里说明既没命中长文表也没命中 bean。此时（且仅此时）才判断形状：用户多半是在问一个
  // 还没写长文的诊断码，回答「暂无长文」比列出全部 bean 有用得多。
  if (matches.length === 0 && looksLikeDiagnosticCode(beanName)) {
    return {
      kind: "problem",
      phase: "argv",
      code: "CLI_USAGE_ERROR",
      message: `No long-form article for "${beanName}" yet, and no bean matches that name either. Long-form articles are tracked at ${unwrittenArticleIssueUrl}`,
    };
  }
  const candidates = (matches.length === 0 ? manifest.beans : matches)
    .map((bean) => bean.id)
    .join(", ");
  return {
    kind: "problem",
    phase: "argv",
    code: "CLI_USAGE_ERROR",
    message:
      matches.length === 0
        ? `No bean matches "${beanName}". Known beans: ${candidates}`
        : `"${beanName}" is ambiguous. Matches: ${candidates}`,
  };
}

// web 面（ADR 0006 W1，#153）：查询以 "/" 开头（可带方法前缀）即路由查询，只读 routes.json
// 静态回答 路径 → 处理链；与 bean 面互不混淆（bean id/导出名/契约名都不会以 "/" 开头）。
async function readRouteManifest(
  projectRoot: string,
): Promise<{ readonly manifest?: RouteManifest; readonly problem?: ExplainOutcome }> {
  const routesPath = join(projectRoot, ".reforce", "generated", "routes.json");
  let bytes: Uint8Array;
  try {
    bytes = await readFile(routesPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return {
        problem: {
          kind: "problem",
          phase: "project",
          code: "ARTIFACT_INVALID",
          message: `No generated route table at ${routesPath}. Run reforce build or reforce dev first.`,
        },
      };
    }
    throw error;
  }
  const manifest = parseRouteManifestBytes(bytes);
  if (manifest === undefined) {
    return {
      problem: {
        kind: "problem",
        phase: "project",
        code: "ARTIFACT_INVALID",
        message: `The generated route table at ${routesPath} is not valid. Rebuild the application.`,
      },
    };
  }
  return { manifest };
}

// 启动摘要折叠路由时印出的出口（RFC 0011 D2，#242），必须无条件可用。
const routeOverviewQuery = "routes";

async function resolveRouteOverview(projectRoot: string): Promise<ExplainOutcome> {
  const { manifest, problem } = await readRouteManifest(projectRoot);
  if (manifest === undefined) {
    return problem ?? { kind: "lines", lines: [] };
  }
  return { kind: "lines", lines: renderRouteOverview(manifest) };
}

async function resolveRouteExplanation(
  projectRoot: string,
  query: string,
): Promise<ExplainOutcome> {
  const { manifest, problem } = await readRouteManifest(projectRoot);
  if (manifest === undefined) {
    return problem ?? { kind: "lines", lines: [] };
  }
  const routeQuery = parseRouteQuery(query);
  if (routeQuery === undefined) {
    throw new Error(`Query "${query}" is not a route query.`);
  }
  const matches = matchRoutes(manifest, routeQuery);
  if (matches.length === 0) {
    return {
      kind: "problem",
      phase: "argv",
      code: "CLI_USAGE_ERROR",
      message: `No route matches "${query}". Known routes: ${knownRouteList(manifest)}`,
    };
  }
  return { kind: "lines", lines: renderRouteExplanation(manifest, matches) };
}

async function resolveExplanation(options: ExplainCommandOptions): Promise<ExplainOutcome> {
  const projectRoot = resolve(options.cwd, options.projectDirectory);
  // `routes` 是保留查询词，排在 bean 面之前：启动摘要把这个字面量印给了用户，它必须无条件
  // 可用。代价是导出名恰好叫 routes 的 bean 在这里被遮住——那个 bean 用完整 id 仍然查得到，
  // 而反过来「摘要给出的出口跑不通」没有任何补救。
  if (options.beanName === routeOverviewQuery) {
    return await resolveRouteOverview(projectRoot);
  }
  if (isRouteQuery(options.beanName)) {
    return await resolveRouteExplanation(projectRoot, options.beanName);
  }
  // 诊断码长文（D8）：只有「命中长文表」才走这条分支，未命中的一律原样落到 bean 面。
  // 用正则猜「看起来像个码」会把全大写的契约 displayName（URL 之类）从 bean 面抢走。
  const article = diagnosticArticle(options.beanName);
  if (article !== undefined) {
    return { kind: "lines", lines: renderDiagnosticArticle(options.beanName, article) };
  }
  const manifestPath = join(projectRoot, ".reforce", "generated", "manifest.json");
  const { manifest, problem } = await readManifest(manifestPath);
  if (manifest === undefined) {
    return {
      kind: "problem",
      phase: "project",
      code: "ARTIFACT_INVALID",
      message: problem ?? "The generated manifest is not readable.",
    };
  }
  const matches = matchBeans(manifest, options.beanName);
  const bean = matches.length === 1 ? matches[0] : undefined;
  if (bean === undefined) {
    return beanLookupProblem(manifest, options.beanName, matches);
  }
  const weavingPath = join(projectRoot, ".reforce", "generated", "weaving.json");
  const { weaving, problem: weavingProblem } = await readWeaving(weavingPath);
  if (weaving === undefined) {
    return {
      kind: "problem",
      phase: "project",
      code: "ARTIFACT_INVALID",
      message: weavingProblem ?? "The generated weaving table is not readable.",
    };
  }
  const starters = await discoverInstalledStarters(projectRoot, starterPackageNames(manifest));
  return {
    kind: "lines",
    lines: renderExplanation({
      manifest,
      bean,
      starters,
      contracts: explainContracts(manifest, starters, bean),
      wovenMethods: wovenMethodsOf(weaving, bean.id),
    }),
  };
}

export async function runExplainCommand(options: ExplainCommandOptions): Promise<0 | 1> {
  const writeOutput =
    options.writeOutput ?? ((line: string) => void process.stdout.write(`${line}\n`));
  let exitCode: 0 | 1 = 1;
  const primaryFailures: unknown[] = [];
  const shutdownFailures: unknown[] = [];
  try {
    const outcome = await resolveExplanation(options);
    if (outcome.kind === "problem") {
      options.reporter.report(
        createFailureEvent({
          command: "explain",
          phase: outcome.phase,
          fallbackCode: outcome.code,
          message: outcome.message,
          cause: undefined,
        }),
      );
    } else {
      for (const line of outcome.lines) {
        writeOutput(line);
      }
      exitCode = 0;
    }
  } catch (error) {
    primaryFailures.push(error);
    options.reporter.report(
      createFailureEvent({
        command: "explain",
        phase: "project",
        fallbackCode: "ARTIFACT_INVALID",
        message: "Explain command failed.",
        cause: error,
      }),
    );
  }

  await captureFailure(() => options.reporter.flush(), shutdownFailures);
  if (shutdownFailures.length > 0) {
    await reportShutdownFailure({
      reporter: options.reporter,
      command: "explain",
      errors: [...primaryFailures, ...shutdownFailures],
    });
    return 1;
  }
  return exitCode;
}
