import { resolve } from "node:path";
import { type CompilerDiagnostic, createCompiler } from "@reforce/compiler";
import {
  captureFailure,
  createFailureEvent,
  type Reporter,
  reportShutdownFailure,
} from "@reforce/runtime/reporter";
import { buildProductionDist } from "@/bundling/production-dist";
import type { Compiler, ResolvedProject } from "@/compiler-types";
import {
  applyDiagnosticPolicy,
  type DiagnosticPolicy,
  deniedByDiagnosticPolicy,
  permissiveDiagnosticPolicy,
} from "@/diagnostic-policy";
import { reportDiagnostics } from "@/diagnostic-reporting";
import { DirectoryTransactionError, DirectoryTransactions } from "@/project/directory-transaction";
import { ProjectBusyError, ProjectLease } from "@/project/lease";

export interface BuildCommandOptions {
  readonly cwd: string;
  readonly projectDirectory: string;
  readonly tsconfigPath?: string;
  readonly reporter: Reporter;
  readonly diagnosticPolicy?: DiagnosticPolicy;
}

export interface BuildCommandDependencies {
  releaseLease(lease: ProjectLease): Promise<void>;
}

const defaultDependencies: BuildCommandDependencies = {
  releaseLease: (lease) => lease.release(),
};

function reportCompilerDiagnostics(
  reporter: Reporter,
  phase: "project" | "compiler",
  diagnostics: readonly CompilerDiagnostic[],
): void {
  reportDiagnostics({ reporter, command: "build", phase, diagnostics });
}

async function buildResolvedProject(input: {
  readonly compiler: Compiler;
  readonly project: ResolvedProject;
  readonly lease: ProjectLease;
  readonly reporter: Reporter;
  readonly diagnosticPolicy: DiagnosticPolicy;
}): Promise<0 | 1> {
  const transactions = await DirectoryTransactions.create({
    projectRoot: input.project.projectRoot,
    lease: input.lease,
  });
  await transactions.recover();
  const compilation = await input.compiler.compile({ project: input.project });
  if (compilation.status === "failure") {
    reportCompilerDiagnostics(input.reporter, "compiler", compilation.diagnostics);
    return 1;
  }
  // 成功路径也要遍历诊断（RFC 0011 OM2，#242）：编译成功不再等于零诊断，只遍历 failure 分支
  // 会让 warning 编出来就消失。
  const warnings = applyDiagnosticPolicy(input.diagnosticPolicy, compilation.diagnostics);
  reportCompilerDiagnostics(input.reporter, "compiler", warnings);
  await transactions.commitGenerated(compilation.files);
  const prepared = await transactions.prepareDist();
  let expectedFiles: readonly string[];
  try {
    expectedFiles = await buildProductionDist({
      project: input.project,
      stagingDirectory: prepared.stagingDirectory,
    });
  } catch (error) {
    try {
      await transactions.recover();
    } catch (recoveryError) {
      throw new AggregateError(
        [error, recoveryError],
        "Production build and transaction recovery failed.",
        { cause: error },
      );
    }
    throw error;
  }
  await transactions.commitDist({ ...prepared, expectedFiles });
  input.reporter.report({
    kind: "success",
    command: "build",
    message: `Built ${input.project.projectRoot}.`,
  });
  // 产物照常落盘：图是完整的，产物有效。非零退出只是给 CI 的闸门信号。
  return deniedByDiagnosticPolicy(input.diagnosticPolicy, warnings) ? 1 : 0;
}

function reportUnexpectedFailure(reporter: Reporter, error: unknown): void {
  if (error instanceof ProjectBusyError) {
    reporter.report(
      createFailureEvent({
        command: "build",
        phase: "project",
        fallbackCode: "PROJECT_BUSY",
        message: error.message,
        cause: error,
      }),
    );
    return;
  }
  if (error instanceof DirectoryTransactionError) {
    reporter.report(
      createFailureEvent({
        command: "build",
        phase: error.code === "GENERATED_TRANSACTION_FAILED" ? "generated-commit" : "dist-commit",
        fallbackCode: error.code,
        message: error.message,
        cause: error,
      }),
    );
    return;
  }
  reporter.report(
    createFailureEvent({
      command: "build",
      phase: "build",
      fallbackCode: "BUILD_FAILED",
      message: "Application build failed.",
      cause: error,
    }),
  );
}

export async function runBuildCommand(
  options: BuildCommandOptions,
  dependencyOverrides: Partial<BuildCommandDependencies> = {},
): Promise<0 | 1> {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const compiler = createCompiler();
  let lease: ProjectLease | undefined;
  let exitCode: 0 | 1 = 1;
  const primaryFailures: unknown[] = [];
  const shutdownFailures: unknown[] = [];
  try {
    const resolution = await compiler.resolveProject({
      projectDirectory: resolve(options.cwd, options.projectDirectory),
      tsconfigPath: options.tsconfigPath,
    });
    if (resolution.status === "failure") {
      reportCompilerDiagnostics(options.reporter, "project", resolution.diagnostics);
    } else {
      lease = await ProjectLease.acquire({
        projectRoot: resolution.project.projectRoot,
        mode: "writer",
      });
      exitCode = await buildResolvedProject({
        compiler,
        project: resolution.project,
        lease,
        reporter: options.reporter,
        diagnosticPolicy: options.diagnosticPolicy ?? permissiveDiagnosticPolicy,
      });
    }
  } catch (error) {
    primaryFailures.push(error);
    reportUnexpectedFailure(options.reporter, error);
  }

  await captureFailure(() => options.reporter.flush(), shutdownFailures);
  if (lease !== undefined) {
    await captureFailure(() => dependencies.releaseLease(lease), shutdownFailures);
  }
  if (shutdownFailures.length > 0) {
    await reportShutdownFailure({
      reporter: options.reporter,
      command: "build",
      errors: [...primaryFailures, ...shutdownFailures],
    });
    return 1;
  }
  return exitCode;
}
