import { resolve } from "node:path";
import { type CompilerDiagnostic, createCompiler } from "@reforce/compiler";
import { writerLeaseTokenEnvironmentVariable } from "@reforce/runtime/dev-ipc";
import { requireNodeExecutable } from "@reforce/runtime/node-runtime";
import { installTerminationSignalHandlers } from "@reforce/runtime/process-signals";
import {
  captureFailure,
  createFailureEvent,
  type Reporter,
  reportShutdownFailure,
} from "@reforce/runtime/reporter";
import { type DevWatchBuild, startDevWatchBuild } from "@/bundling/dev-watch";
import { spawnDevChild } from "@/dev/child-process";
import { DevChildSupervisor } from "@/dev/child-supervisor";
import { DevCompilerGate } from "@/dev/compiler-gate";
import { collectInstallSignalInputs } from "@/dev/install-signals";
import { type DevCompilation, DevWatchCoordinator } from "@/dev/watch-coordinator";
import { DirectoryTransactions } from "@/project/directory-transaction";
import { ProjectBusyError, ProjectLease } from "@/project/lease";

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

// The controller must be wired (signal handlers, supervisor callbacks) before the real watch
// handle exists, because those callbacks can trigger a shutdown while startDevWatchBuild is
// still in flight. This placeholder makes the controller closable from the start and accepts
// the real watch exactly once, so an early shutdown never hangs waiting for the build.
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
    // 两个阶段各报各的文案：一行 stderr 就能看出失败的是 watcher 还是子进程（Issue #32）。
    await this.runShutdownStage("Development watch shutdown failed.", errors, () =>
      this.watch.close(),
    );
    await this.runShutdownStage("Development child shutdown failed.", errors, () =>
      this.supervisor.shutdown(signal),
    );
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

  private async runShutdownStage(
    message: string,
    errors: unknown[],
    stage: () => Promise<void>,
  ): Promise<void> {
    try {
      await stage();
    } catch (error) {
      errors.push(error);
      this.reporter.report(
        createFailureEvent({
          command: "dev",
          phase: "shutdown",
          fallbackCode: "SHUTDOWN_FAILED",
          message,
          cause: error,
        }),
      );
    }
  }
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

export async function runDevCommand(
  options: DevCommandOptions,
  dependencies: DevCommandDependencies = defaultDependencies,
): Promise<0 | 1> {
  const projectDirectory = resolve(options.cwd, options.projectDirectory);
  const tsconfigPath =
    options.tsconfigPath === undefined ? {} : { tsconfigPath: options.tsconfigPath };
  const compiler = createCompiler();
  const resolution = await compiler.resolveProject({
    projectDirectory,
    ...tsconfigPath,
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
      ...tsconfigPath,
      project: resolution.project,
      initialWatchInputs: resolution.watchInputs,
      installSignalInputs: await collectInstallSignalInputs(resolution.project.projectRoot),
      generatedOutput: transactions,
    });
    await gate.initialize();

    const { promise: completion, resolve: resolveCompletion } = Promise.withResolvers<0 | 1>();
    let finishPromise: Promise<void> | undefined;
    const finish = (code: 0 | 1, signal?: NodeJS.Signals) => {
      finishPromise ??= (async () => {
        try {
          await controller?.shutdown(signal);
          resolveCompletion(code);
        } catch {
          resolveCompletion(1);
        }
      })();
      return finishPromise;
    };
    const supervisor = new DevChildSupervisor({
      spawn: async () =>
        await spawnDevChild({
          entryPath: resolve(resolution.project.projectRoot, ".reforce", "dev", "main.mjs"),
          cwd: resolution.project.projectRoot,
          nodeExecutable: requireNodeExecutable(),
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
    const coordinator = new DevWatchCoordinator({ reporter: options.reporter, supervisor });
    deferredWatch = new DeferredDevWatch();
    controller = new DevCommandController({
      watch: deferredWatch,
      watchCoordinator: coordinator,
      supervisor,
      reporter: options.reporter,
    });
    detachSignals = installTerminationSignalHandlers((signal) => {
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
      // Attach a noop watch so a shutdown already in flight can finish closing instead of
      // hanging on a real watch that will never arrive.
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

  try {
    detachSignals();
  } catch (error) {
    shutdownFailures.push(error);
  }
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
