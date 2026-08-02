import type { CompilerDiagnostic } from "@reforce/compiler";
import type { DevChildSupervisor } from "./dev-child-supervisor";
import { createFailureEvent, type Reporter } from "./reporter";

export interface FailedDevCompilation {
  readonly status: "failure";
  readonly diagnostics: readonly CompilerDiagnostic[];
  readonly error?: unknown;
}

export interface SuccessfulDevCompilation {
  readonly status: "success";
  readonly buildId: string;
  readonly validateAssets: () => Promise<void>;
}

export type DevCompilation = FailedDevCompilation | SuccessfulDevCompilation;

export class DevWatchCoordinator {
  readonly #reporter: Reporter;
  readonly #supervisor: DevChildSupervisor;
  #healthyBuildId: string | undefined;

  constructor(options: {
    readonly reporter: Reporter;
    readonly supervisor: DevChildSupervisor;
  }) {
    this.#reporter = options.reporter;
    this.#supervisor = options.supervisor;
  }

  get healthyBuildId(): string | undefined {
    return this.#healthyBuildId;
  }

  async acceptCompilation(compilation: DevCompilation): Promise<void> {
    if (compilation.status === "failure") {
      for (const diagnostic of compilation.diagnostics) {
        this.#reporter.report({
          kind: "diagnostic",
          command: "dev",
          phase: "compiler",
          diagnostic,
        });
      }
      if (compilation.error !== undefined) {
        this.#reporter.report(
          createFailureEvent({
            command: "dev",
            phase: "build",
            fallbackCode: "BUILD_FAILED",
            message: "Development compilation failed.",
            cause: compilation.error,
          }),
        );
      }
      this.#reporter.report({
        kind: "status",
        command: "dev",
        phase: "build",
        message: "Compilation failed; the last healthy application remains active.",
      });
      await this.#supervisor.acceptBuildFailure();
      return;
    }
    try {
      await compilation.validateAssets();
    } catch (error) {
      this.#reporter.report(
        createFailureEvent({
          command: "dev",
          phase: "build",
          fallbackCode: "ARTIFACT_INVALID",
          message: "Development assets failed validation.",
          cause: error,
        }),
      );
      await this.#supervisor.acceptBuildFailure();
      return;
    }
    this.#healthyBuildId = compilation.buildId;
    await this.#supervisor.acceptSuccessfulBuild(compilation.buildId);
  }
}
