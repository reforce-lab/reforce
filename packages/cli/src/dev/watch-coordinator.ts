import type { CompilerDiagnostic } from "@reforce/compiler";
import { createFailureEvent, type Reporter } from "@reforce/runtime/reporter";
import type { DevChildSupervisor } from "@/dev/child-supervisor";
import {
  applyDiagnosticPolicy,
  type DiagnosticPolicy,
  permissiveDiagnosticPolicy,
} from "@/diagnostic-policy";
import { reportDiagnostics } from "@/diagnostic-reporting";

interface FailedDevCompilation {
  readonly status: "failure";
  readonly diagnostics: readonly CompilerDiagnostic[];
  readonly error?: unknown;
}

interface SuccessfulDevCompilation {
  readonly status: "success";
  // 成功也可能带诊断，且必然全是 warning（RFC 0011 OM2，#242）。dev 下 warning 不拦子进程：
  // 图完整、产物可用，拦下只会把「有话要说」变成「跑不起来」。
  readonly diagnostics: readonly CompilerDiagnostic[];
  readonly buildId: string;
  readonly validateAssets: () => Promise<void>;
}

export type DevCompilation = FailedDevCompilation | SuccessfulDevCompilation;

export class DevWatchCoordinator {
  private readonly reporter: Reporter;
  private readonly supervisor: DevChildSupervisor;
  private readonly diagnosticPolicy: DiagnosticPolicy;
  private healthyBuildIdValue: string | undefined;

  constructor(options: {
    readonly reporter: Reporter;
    readonly supervisor: DevChildSupervisor;
    readonly diagnosticPolicy?: DiagnosticPolicy;
  }) {
    this.reporter = options.reporter;
    this.supervisor = options.supervisor;
    this.diagnosticPolicy = options.diagnosticPolicy ?? permissiveDiagnosticPolicy;
  }

  get healthyBuildId(): string | undefined {
    return this.healthyBuildIdValue;
  }

  async acceptCompilation(compilation: DevCompilation): Promise<void> {
    if (compilation.status === "failure") {
      reportDiagnostics({
        reporter: this.reporter,
        command: "dev",
        phase: "compiler",
        diagnostics: compilation.diagnostics,
      });
      if (compilation.error !== undefined) {
        this.reporter.report(
          createFailureEvent({
            command: "dev",
            phase: "build",
            fallbackCode: "BUILD_FAILED",
            message: "Development compilation failed.",
            cause: compilation.error,
          }),
        );
      }
      this.reporter.report({
        kind: "status",
        command: "dev",
        phase: "build",
        message: "Compilation failed; the last healthy application remains active.",
      });
      await this.supervisor.acceptBuildFailure();
      return;
    }
    reportDiagnostics({
      reporter: this.reporter,
      command: "dev",
      phase: "compiler",
      diagnostics: applyDiagnosticPolicy(this.diagnosticPolicy, compilation.diagnostics),
    });
    try {
      await compilation.validateAssets();
    } catch (error) {
      this.reporter.report(
        createFailureEvent({
          command: "dev",
          phase: "build",
          fallbackCode: "ARTIFACT_INVALID",
          message: "Development assets failed validation.",
          cause: error,
        }),
      );
      await this.supervisor.acceptBuildFailure();
      return;
    }
    this.healthyBuildIdValue = compilation.buildId;
    // 重载行（RFC 0011 D2，#242）：此前成功重建这条路径**一句话都不说**——改一行代码，
    // 终端上什么都没发生，用户分不清是没触发还是编译还没完。transient 让它在 TTY 上原地
    // 重写，改一百次也只占一行；管道与 json 里它是普通的一条事件，一条不少。
    this.reporter.report({
      kind: "status",
      command: "dev",
      phase: "hmr",
      message: `Reloaded the development application (build ${compilation.buildId}).`,
      transient: true,
    });
    await this.supervisor.acceptSuccessfulBuild(compilation.buildId);
  }
}
