import { resolve } from "node:path";
import { type CompilerDiagnostic, createCompiler } from "@reforce/compiler";
import { requireBunExecutable } from "@/bun-runtime";
import { spawnDevChild } from "@/dev-child-process";
import type { DevChildSupervisor } from "@/dev-child-supervisor";
import { DevChildSupervisor as ChildSupervisor } from "@/dev-child-supervisor";
import { DevCompilerGate } from "@/dev-compiler-gate";
import { writerLeaseTokenEnvironmentVariable } from "@/dev-ipc";
import { startDevWatchBuild } from "@/dev-watch-build";
import type { DevCompilation, DevWatchCoordinator } from "@/dev-watch-coordinator";
import { DevWatchCoordinator as WatchCoordinator } from "@/dev-watch-coordinator";
import { DirectoryTransactions } from "@/directory-transaction";
import { ProjectBusyError, ProjectLease } from "@/project-lease";
import { createFailureEvent, type Reporter, reportShutdownFailure } from "@/reporter";

export interface DevWatchBuild {
  close(): Promise<void>;
}

export interface DevCommandOptions {
  readonly cwd: string;
  readonly projectDirectory: string;
  readonly tsconfigPath?: string;
  readonly reporter: Reporter;
}

export interface DevCommandDependencies {
  releaseLease(lease: ProjectLease): Promise<void>;
}

const defaultDependencies: DevCommandDependencies = {
  releaseLease: (lease) => lease.release(),
};

class DeferredDevWatch implements DevWatchBuild {
  private readonly watch: Promise<DevWatchBuild>;
  private readonly resolveWatch: (watch: DevWatchBuild) => void;
  private attached = false;

  constructor() {
    const watch = Promise.withResolvers<DevWatchBuild>();
    this.watch = watch.promise;
    this.resolveWatch = watch.resolve;
  }

  attach(watch: DevWatchBuild): void {
    if (this.attached) {
      throw new Error("Development watch can only be attached once.");
    }
    this.attached = true;
    this.resolveWatch(watch);
  }

  async close(): Promise<void> {
    const watch = await this.watch;
    await watch.close();
  }
}

export class DevCommandController {
  private readonly reporter: Reporter;
  private readonly supervisor: DevChildSupervisor;
  private readonly watch: DevWatchBuild;
  private readonly watchCoordinator: DevWatchCoordinator;
  private shutdownPromise: Promise<void> | undefined;

  constructor(options: {
    readonly watch: DevWatchBuild;
    readonly watchCoordinator: DevWatchCoordinator;
    readonly supervisor: DevChildSupervisor;
    readonly reporter: Reporter;
  }) {
    this.watch = options.watch;
    this.watchCoordinator = options.watchCoordinator;
    this.supervisor = options.supervisor;
    this.reporter = options.reporter;
  }

  acceptCompilation(compilation: DevCompilation): Promise<void> {
    return this.watchCoordinator.acceptCompilation(compilation);
  }

  shutdown(signal?: NodeJS.Signals): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }
    this.shutdownPromise = this.shutdownOnce(signal);
    return this.shutdownPromise;
  }

  private async shutdownOnce(signal?: NodeJS.Signals): Promise<void> {
    const errors: unknown[] = [];
    try {
      await this.watch.close();
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.supervisor.shutdown(signal);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      const primary = errors[0];
      this.reporter.report(
        createFailureEvent({
          command: "dev",
          phase: "shutdown",
          fallbackCode: "SHUTDOWN_FAILED",
          message: "Development shutdown failed.",
          cause: primary,
        }),
      );
    }
    try {
      await this.reporter.flush();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Development shutdown failed.", {
        cause: errors[0],
      });
    }
  }
}

function installParentSignalHandlers(onSignal: (signal: NodeJS.Signals) => void): () => void {
  const signals: NodeJS.Signals[] =
    process.platform === "win32" ? ["SIGINT", "SIGBREAK"] : ["SIGINT", "SIGTERM"];
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of signals) {
    const handler = () => onSignal(signal);
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) {
      process.off(signal, handler);
    }
  };
}

function reportCommandFailure(reporter: Reporter, error: unknown): void {
  const busy = error instanceof ProjectBusyError;
  reporter.report(
    createFailureEvent({
      command: "dev",
      phase: busy ? "project" : "build",
      fallbackCode: busy ? "PROJECT_BUSY" : "BUILD_FAILED",
      message: busy ? error.message : "Development command failed.",
      cause: error,
    }),
  );
}

async function reportProjectResolutionFailure(
  reporter: Reporter,
  diagnostics: readonly CompilerDiagnostic[],
): Promise<1> {
  for (const diagnostic of diagnostics) {
    reporter.report({
      kind: "diagnostic",
      command: "dev",
      phase: "project",
      diagnostic,
    });
  }
  const shutdownFailures: unknown[] = [];
  await captureFailure(() => reporter.flush(), shutdownFailures);
  if (shutdownFailures.length > 0) {
    await reportShutdownFailure({ reporter, command: "dev", errors: shutdownFailures });
  }
  return 1;
}

async function captureFailure(operation: () => Promise<void>, failures: unknown[]): Promise<void> {
  try {
    await operation();
  } catch (error) {
    failures.push(error);
  }
}

function captureSynchronousFailure(operation: () => void, failures: unknown[]): void {
  try {
    operation();
  } catch (error) {
    failures.push(error);
  }
}

export async function runDevCommand(
  options: DevCommandOptions,
  dependencies: DevCommandDependencies = defaultDependencies,
): Promise<0 | 1> {
  const projectDirectory = resolve(options.cwd, options.projectDirectory);
  const compiler = createCompiler();
  const resolution = await compiler.resolveProject({
    projectDirectory,
    ...(options.tsconfigPath === undefined ? {} : { tsconfigPath: options.tsconfigPath }),
  });
  if (resolution.status === "failure") {
    return await reportProjectResolutionFailure(options.reporter, resolution.diagnostics);
  }

  let lease: ProjectLease | undefined;
  let controller: DevCommandController | undefined;
  let deferredWatch: DeferredDevWatch | undefined;
  let detachSignals: () => void = () => undefined;
  let exitCode: 0 | 1 = 1;
  const primaryFailures: unknown[] = [];
  const shutdownFailures: unknown[] = [];
  try {
    const writerLease = await ProjectLease.acquire({
      projectRoot: resolution.project.projectRoot,
      mode: "writer",
    });
    lease = writerLease;
    const transactions = await DirectoryTransactions.create({
      projectRoot: resolution.project.projectRoot,
      lease: writerLease,
    });
    await transactions.recover();
    const gate = new DevCompilerGate({
      compiler,
      projectDirectory,
      ...(options.tsconfigPath === undefined ? {} : { tsconfigPath: options.tsconfigPath }),
      project: resolution.project,
      initialWatchInputs: resolution.watchInputs,
      generatedOutput: transactions,
    });
    await gate.initialize();

    const { promise: completion, resolve: resolveCompletion } = Promise.withResolvers<0 | 1>();
    let finishPromise: Promise<void> | undefined;
    const finish = (exitCode: 0 | 1, signal?: NodeJS.Signals) => {
      finishPromise ??= (async () => {
        try {
          await controller?.shutdown(signal);
          resolveCompletion(exitCode);
        } catch {
          resolveCompletion(1);
        }
      })();
      return finishPromise;
    };
    const supervisor = new ChildSupervisor({
      spawn: async () =>
        await spawnDevChild({
          entryPath: resolve(resolution.project.projectRoot, ".reforce", "dev", "main.mjs"),
          cwd: resolution.project.projectRoot,
          bunExecutable: requireBunExecutable(),
          env: { [writerLeaseTokenEnvironmentVariable]: writerLease.leaseToken },
          waitForReady: true,
          leaseParticipant: {
            add: (participant) => writerLease.addParticipant(participant),
            remove: (participantToken) => writerLease.removeParticipant(participantToken),
          },
        }),
      onChildFailure: (failure) => {
        options.reporter.report({
          kind: "status",
          command: "dev",
          phase: "child",
          message: `Development child exited unexpectedly${failure.exitCode === null ? "" : ` with code ${failure.exitCode}`}.`,
        });
      },
      onTerminalFailure: (failure) => {
        options.reporter.report(
          createFailureEvent({
            command: "dev",
            phase: "child",
            fallbackCode: "CHILD_FAILED",
            message: "Development child exhausted its restart budget.",
            cause: failure.error ?? failure,
          }),
        );
        void finish(1);
      },
      onNaturalExit: () => {
        void finish(0);
      },
    });
    const coordinator = new WatchCoordinator({ reporter: options.reporter, supervisor });
    deferredWatch = new DeferredDevWatch();
    controller = new DevCommandController({
      watch: deferredWatch,
      watchCoordinator: coordinator,
      supervisor,
      reporter: options.reporter,
    });
    detachSignals = installParentSignalHandlers((signal) => {
      void finish(0, signal);
    });
    try {
      const watch = await startDevWatchBuild({
        project: resolution.project,
        gate,
        onCompilation: (compilation) =>
          controller?.acceptCompilation(compilation) ?? Promise.resolve(),
      });
      deferredWatch.attach(watch);
    } catch (error) {
      deferredWatch.attach({ close: async () => undefined });
      throw error;
    }
    exitCode = await completion;
  } catch (error) {
    primaryFailures.push(error);
    reportCommandFailure(options.reporter, error);
    if (controller) {
      try {
        await controller.shutdown();
      } catch {}
    } else {
      await captureFailure(() => options.reporter.flush(), shutdownFailures);
    }
    exitCode = 1;
  }

  captureSynchronousFailure(detachSignals, shutdownFailures);
  if (lease !== undefined) {
    await captureFailure(() => dependencies.releaseLease(lease), shutdownFailures);
  }
  if (shutdownFailures.length > 0) {
    await reportShutdownFailure({
      reporter: options.reporter,
      command: "dev",
      errors: [...primaryFailures, ...shutdownFailures],
    });
    return 1;
  }
  return exitCode;
}
