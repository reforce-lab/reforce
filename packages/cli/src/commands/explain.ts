import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { renderExplanation } from "@/explain/render";
import { explainContracts } from "@/explain/selection";
import { discoverInstalledStarters } from "@/explain/starter-metas";
import { isMissingPathError } from "@/project/fs-error";
import {
  type GeneratedManifest,
  type ManifestBean,
  parseGeneratedManifestBytes,
  starterOriginPackageName,
} from "@/project/generated-manifest";
import {
  captureFailure,
  createFailureEvent,
  type Reporter,
  reportShutdownFailure,
} from "@/reporter";

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

async function resolveExplanation(options: ExplainCommandOptions): Promise<ExplainOutcome> {
  const projectRoot = resolve(options.cwd, options.projectDirectory);
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
  const starters = await discoverInstalledStarters(projectRoot, starterPackageNames(manifest));
  return {
    kind: "lines",
    lines: renderExplanation({
      manifest,
      bean,
      starters,
      contracts: explainContracts(manifest, starters, bean),
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
