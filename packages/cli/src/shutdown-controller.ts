import { isObject } from "radashi";
import {
  type CliCommandName,
  type CliFailureCode,
  type CliFailurePhase,
  createFailureEvent,
  type Reporter,
} from "./reporter";

export type ShutdownState = "bootstrapping" | "running" | "shutting-down" | "finished";

export interface CloseableApplication {
  close(): Promise<void>;
}

export interface ShutdownFailure {
  readonly error: unknown;
  readonly code: CliFailureCode;
  readonly phase: CliFailurePhase;
  readonly message: string;
}

export interface ShutdownResult {
  readonly exitCode: 0 | 1;
  readonly primaryError?: unknown;
  readonly errors: readonly unknown[];
}

export interface ShutdownRequestMessage {
  readonly type: "reforce:shutdown";
  readonly requestId: string;
}

export interface ShutdownAckMessage {
  readonly type: "reforce:shutdown-ack";
  readonly requestId: string;
  readonly ok: boolean;
  readonly code?: "SHUTDOWN_FAILED";
}

interface ShutdownControllerOptions {
  readonly command: CliCommandName;
  readonly reporter: Reporter;
}

function isShutdownRequestMessage(value: unknown): value is ShutdownRequestMessage {
  if (!isObject(value)) {
    return false;
  }
  return (
    Reflect.get(value, "type") === "reforce:shutdown" &&
    typeof Reflect.get(value, "requestId") === "string"
  );
}

export class ShutdownController {
  readonly #command: CliCommandName;
  readonly #reporter: Reporter;
  readonly #completion: Promise<ShutdownResult>;
  readonly #resolveCompletion: (result: ShutdownResult) => void;
  readonly #acknowledgements: Array<(result: ShutdownResult) => void> = [];
  #application?: CloseableApplication;
  #detachHandlers: () => void = () => undefined;
  #failure?: ShutdownFailure;
  #requested = false;
  #shutdownPromise?: Promise<ShutdownResult>;
  #started = false;
  #state: ShutdownState = "bootstrapping";

  constructor(options: ShutdownControllerOptions) {
    this.#command = options.command;
    this.#reporter = options.reporter;
    const completion = Promise.withResolvers<ShutdownResult>();
    this.#completion = completion.promise;
    this.#resolveCompletion = completion.resolve;
  }

  get state(): ShutdownState {
    return this.#state;
  }

  get finished(): Promise<ShutdownResult> {
    return this.#completion;
  }

  setHandlerCleanup(detachHandlers: () => void): void {
    this.#detachHandlers = detachHandlers;
  }

  async start(bootstrap: () => Promise<CloseableApplication>): Promise<void> {
    if (this.#started) {
      throw new Error("The shutdown controller bootstrap can only run once.");
    }
    this.#started = true;

    try {
      const application = await bootstrap();
      this.#application = application;
      if (this.#requested) {
        this.#state = "shutting-down";
        await this.#beginShutdown();
        return;
      }
      this.#state = "running";
    } catch (error) {
      this.#failure ??= {
        error,
        code: "BOOTSTRAP_FAILED",
        phase: "bootstrap",
        message: "Application bootstrap failed.",
      };
      this.#requested = true;
      this.#state = "shutting-down";
      await this.#beginShutdown();
    }
  }

  requestShutdown(failure?: ShutdownFailure): Promise<ShutdownResult> {
    this.#requested = true;
    this.#failure ??= failure;
    if (this.#state === "running") {
      this.#state = "shutting-down";
      void this.#beginShutdown();
    }
    return this.#completion;
  }

  receiveIpcMessage(message: unknown, acknowledge: (message: ShutdownAckMessage) => void): boolean {
    if (!isShutdownRequestMessage(message)) {
      return false;
    }
    this.#acknowledgements.push((result) => {
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

  #beginShutdown(): Promise<ShutdownResult> {
    this.#shutdownPromise ??= this.#performShutdown();
    return this.#shutdownPromise;
  }

  async #performShutdown(): Promise<ShutdownResult> {
    this.#detachHandlers();
    const errors: unknown[] = [];
    let primaryError = this.#failure?.error;

    if (this.#failure) {
      errors.push(this.#failure.error);
      this.#reporter.report(
        createFailureEvent({
          command: this.#command,
          phase: this.#failure.phase,
          fallbackCode: this.#failure.code,
          message: this.#failure.message,
          cause: this.#failure.error,
        }),
      );
    }

    if (this.#application) {
      try {
        await this.#application.close();
      } catch (error) {
        primaryError ??= error;
        errors.push(error);
        this.#reporter.report(
          createFailureEvent({
            command: this.#command,
            phase: "shutdown",
            fallbackCode: "SHUTDOWN_FAILED",
            message: "Application shutdown failed.",
            cause: error,
          }),
        );
      }
    }

    try {
      await this.#reporter.flush();
    } catch (error) {
      primaryError ??= error;
      errors.push(error);
    }

    const result: ShutdownResult = {
      exitCode: errors.length === 0 ? 0 : 1,
      ...(primaryError === undefined ? {} : { primaryError }),
      errors: Object.freeze(errors),
    };
    this.#state = "finished";
    for (const acknowledge of this.#acknowledgements.splice(0)) {
      acknowledge(result);
    }
    this.#resolveCompletion(result);
    return result;
  }
}

export function installProcessShutdownHandlers(controller: ShutdownController): () => void {
  const signalNames: NodeJS.Signals[] =
    process.platform === "win32" ? ["SIGINT", "SIGBREAK"] : ["SIGINT", "SIGTERM"];
  const onSignal = () => {
    void controller.requestShutdown();
  };
  const onMessage = (message: unknown) => {
    controller.receiveIpcMessage(message, (acknowledgement) => {
      process.send?.(acknowledgement);
    });
  };
  const onDisconnect = () => {
    void controller.requestShutdown();
  };

  for (const signalName of signalNames) {
    process.on(signalName, onSignal);
  }
  process.on("message", onMessage);
  process.on("disconnect", onDisconnect);

  const detach = () => {
    for (const signalName of signalNames) {
      process.off(signalName, onSignal);
    }
    process.off("message", onMessage);
    process.off("disconnect", onDisconnect);
  };
  controller.setHandlerCleanup(detach);
  return detach;
}
