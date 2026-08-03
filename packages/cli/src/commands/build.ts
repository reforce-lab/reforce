import { resolve } from "node:path";
import { type CompilerDiagnostic, createCompiler } from "@reforce/compiler";
import { buildProductionDist } from "@/bundling/production-dist";
import type { Compiler, ResolvedProject } from "@/compiler-types";
import { DirectoryTransactionError, DirectoryTransactions } from "@/project/directory-transaction";
import { ProjectBusyError, ProjectLease } from "@/project/lease";
import { createFailureEvent, type Reporter, reportShutdownFailure } from "@/reporter";

export interface BuildCommandOptions {
  readonly cwd: string;
  readonly projectDirectory: string;
  readonly tsconfigPath?: string;
  readonly reporter: Reporter;
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
  for (const diagnostic of diagnostics) {
    reporter.report({ kind: "diagnostic", command: "build", phase, diagnostic });
  }
}

async function buildResolvedProject(input: {
  readonly compiler: Compiler;
  readonly project: ResolvedProject;
  readonly lease: ProjectLease;
  readonly reporter: Reporter;
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
  return 0;
}

async function captureFailure(operation: () => Promise<void>, failures: unknown[]): Promise<void> {
  try {
    await operation();
  } catch (error) {
    failures.push(error);
  }
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
