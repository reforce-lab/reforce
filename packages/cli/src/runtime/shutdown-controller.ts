import { isShutdownRequestMessage, type ShutdownAckMessage } from "@/dev-ipc";
import { installTerminationSignalHandlers } from "@/process-signals";
import {
  type CliCommandName,
  type CliCommandPhase,
  type CliFailureCode,
  createFailureEvent,
  type Reporter,
} from "@/reporter";

export type ShutdownState = "bootstrapping" | "running" | "shutting-down" | "finished";

export interface CloseableApplication {
  close(): Promise<void>;
}

export interface ShutdownFailure {
  readonly error: unknown;
  readonly code: CliFailureCode;
  readonly phase: CliCommandPhase;
  readonly message: string;
}

export interface ShutdownResult {
  readonly exitCode: 0 | 1;
  readonly primaryError?: unknown;
  readonly errors: readonly unknown[];
}

interface ShutdownControllerOptions {
  readonly command: CliCommandName;
  readonly reporter: Reporter;
}

export class ShutdownController {
  private readonly command: CliCommandName;
  private readonly reporter: Reporter;
  private readonly completion: Promise<ShutdownResult>;
  private readonly resolveCompletion: (result: ShutdownResult) => void;
  private readonly acknowledgements: Array<(result: ShutdownResult) => void> = [];
  private application?: CloseableApplication;
  private detachHandlers: () => void = () => undefined;
  private failure?: ShutdownFailure;
  private requested = false;
  private shutdownPromise?: Promise<ShutdownResult>;
  private started = false;
  private stateValue: ShutdownState = "bootstrapping";

  constructor(options: ShutdownControllerOptions) {
    this.command = options.command;
    this.reporter = options.reporter;
    const completion = Promise.withResolvers<ShutdownResult>();
    this.completion = completion.promise;
    this.resolveCompletion = completion.resolve;
  }

  get state(): ShutdownState {
    return this.stateValue;
  }

  get finished(): Promise<ShutdownResult> {
    return this.completion;
  }

  setHandlerCleanup(detachHandlers: () => void): void {
    this.detachHandlers = detachHandlers;
  }

  async start(bootstrap: () => Promise<CloseableApplication>): Promise<void> {
    if (this.started) {
      throw new Error("The shutdown controller bootstrap can only run once.");
    }
    this.started = true;

    try {
      const application = await bootstrap();
      this.application = application;
      if (this.requested) {
        this.stateValue = "shutting-down";
        await this.beginShutdown();
        return;
      }
      this.stateValue = "running";
    } catch (error) {
      this.failure ??= {
        error,
        code: "BOOTSTRAP_FAILED",
        phase: "bootstrap",
        message: "Application bootstrap failed.",
      };
      this.stateValue = "shutting-down";
      await this.beginShutdown();
    }
  }

  requestShutdown(failure?: ShutdownFailure): Promise<ShutdownResult> {
    this.requested = true;
    this.failure ??= failure;
    if (this.stateValue === "running") {
      this.stateValue = "shutting-down";
      void this.beginShutdown();
    }
    return this.completion;
  }

  receiveIpcMessage(message: unknown, acknowledge: (message: ShutdownAckMessage) => void): boolean {
    if (!isShutdownRequestMessage(message)) {
      return false;
    }
    this.acknowledgements.push((result) => {
      acknowledge({
        type: "reforce:shutdown-ack",
        requestId: message.requestId,
        ok: result.exitCode === 0,
        ...(result.exitCode === 0 ? {} : { code: "SHUTDOWN_FAILED" }),
      });
    });
    void this.requestShutdown();
    return true;
  }

  private beginShutdown(): Promise<ShutdownResult> {
    this.shutdownPromise ??= this.performShutdown();
    return this.shutdownPromise;
  }

  private async performShutdown(): Promise<ShutdownResult> {
    this.detachHandlers();
    const errors: unknown[] = [];
    let primaryError = this.failure?.error;

    if (this.failure) {
      errors.push(this.failure.error);
      this.reporter.report(
        createFailureEvent({
          command: this.command,
          phase: this.failure.phase,
          fallbackCode: this.failure.code,
          message: this.failure.message,
          cause: this.failure.error,
        }),
      );
    }

    if (this.application) {
      try {
        await this.application.close();
      } catch (error) {
        primaryError ??= error;
        errors.push(error);
        this.reporter.report(
          createFailureEvent({
            command: this.command,
            phase: "shutdown",
            fallbackCode: "SHUTDOWN_FAILED",
            message: "Application shutdown failed.",
            cause: error,
          }),
        );
      }
    }

    try {
      await this.reporter.flush();
    } catch (error) {
      primaryError ??= error;
      errors.push(error);
    }

    const result: ShutdownResult = {
      exitCode: errors.length === 0 ? 0 : 1,
      ...(primaryError === undefined ? {} : { primaryError }),
      errors: Object.freeze(errors),
    };
    this.stateValue = "finished";
    for (const acknowledge of this.acknowledgements.splice(0)) {
      acknowledge(result);
    }
    this.resolveCompletion(result);
    return result;
  }
}

export function installProcessShutdownHandlers(controller: ShutdownController): void {
  const onMessage = (message: unknown) => {
    controller.receiveIpcMessage(message, (acknowledgement) => {
      process.send?.(acknowledgement);
    });
  };
  const onDisconnect = () => {
    void controller.requestShutdown();
  };

  // 这里刻意忽略回调传回的信号名：controller 的关停路径对 SIGINT / SIGTERM / SIGBREAK 一视同仁。
  const detachSignalHandlers = installTerminationSignalHandlers(() => {
    void controller.requestShutdown();
  });
  process.on("message", onMessage);
  process.on("disconnect", onDisconnect);

  controller.setHandlerCleanup(() => {
    detachSignalHandlers();
    process.off("message", onMessage);
    process.off("disconnect", onDisconnect);
  });
}
