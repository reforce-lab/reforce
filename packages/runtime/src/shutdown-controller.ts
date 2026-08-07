import { isShutdownRequestMessage, type ShutdownAckMessage } from "@/dev-ipc";
import type { CliFailureCode } from "@/error-codes";
import { installTerminationSignalHandlers } from "@/process-signals";
import {
  type CliCommandName,
  type CliCommandPhase,
  createFailureEvent,
  type Reporter,
} from "@/reporter";
import { withTimeout } from "@/with-timeout";

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

// 关停输出要的最小 logger 形状，由**消费侧**定义（同 web 的 RequestLogger、logging 的
// StartupSummaryLogger）。@reforce/logging 的 Logger 结构性满足它，生成的 bootstrap 把那个
// 实例交进来。
//
// 这里不写 `import type { Logger } from "@reforce/logging"` 的理由比 web 那边更硬：
// @reforce/logging 自己依赖 @reforce/runtime（startup-summary 用 runtime/terminal），反向
// import 直接成环——哪怕只是 type-only，它也会留在生成的 d.ts 里。
export interface ShutdownLogger {
  info(fields: Readonly<Record<string, unknown>> | undefined, message: string): void;
}

// 关停的起因（RFC 0011 C3，#250）。只列**能被日志看见**的那几种：bootstrap 失败与 dev 的
// HMR fatal 发生时 logger 还不存在（容器没起来 / dev 不接 logger），给它们编名字是造死代码。
export type ShutdownTrigger = NodeJS.Signals | "ipc" | "parent-disconnect";

// 排空预算，与崩溃接管同一个数、同一个理由（crash-takeover.ts）：给死的而不是给旋钮，
// 超时的后果（记一次关停错误、继续退出）本来就不该由调用方调。
const flushBudgetMilliseconds = 2_000;

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
  private logger?: ShutdownLogger;
  private requested = false;
  private shutdownPromise?: Promise<ShutdownResult>;
  private started = false;
  private stateValue: ShutdownState = "bootstrapping";
  private trigger?: ShutdownTrigger;

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

  // 关停 logger 只能在 bootstrap 之后交进来：它是容器里的一条 bean，而 controller 必须先于
  // bootstrap 存在（信号处理器要先装）。缺席即不打——不写日志的应用不该被迫装 @reforce/logging。
  setLogger(logger: ShutdownLogger): void {
    this.logger = logger;
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

  // trigger 排在 failure 之后：dev-entry 是按位置传 failure 的，换序会静默传错参数。
  requestShutdown(failure?: ShutdownFailure, trigger?: ShutdownTrigger): Promise<ShutdownResult> {
    this.requested = true;
    this.failure ??= failure;
    this.trigger ??= trigger;
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
      const ok = result.exitCode === 0;
      acknowledge({
        type: "reforce:shutdown-ack",
        requestId: message.requestId,
        ok,
        code: ok ? undefined : "SHUTDOWN_FAILED",
      });
    });
    void this.requestShutdown(undefined, "ipc");
    return true;
  }

  private beginShutdown(): Promise<ShutdownResult> {
    this.shutdownPromise ??= this.performShutdown();
    return this.shutdownPromise;
  }

  private async performShutdown(): Promise<ShutdownResult> {
    this.detachHandlers();
    const startedAt = Date.now();
    // 「收到信号」与「开始排空」在有 logger 的每条路径上都是同一刻：requestShutdown 在
    // running 态里同步排上 beginShutdown。唯一分开的是引导期请求的关停，而那时 setLogger
    // 还没跑过，为它单写一行等于写一行永远打不出来的日志。
    this.log(this.trigger === undefined ? undefined : { trigger: this.trigger }, "shutting down");
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
      // 排空自身上预算（RFC 0011 L7 的字面要求）：sink 可能是对端已死的管道，没有预算时
      // 一次挂起的 flush 会把整个关停吊死——超时算一次关停错误，而不是无限等。
      await withTimeout(
        this.reporter.flush(),
        flushBudgetMilliseconds,
        "Reporter flush timed out.",
      );
    } catch (error) {
      primaryError ??= error;
      errors.push(error);
    }

    const result: ShutdownResult = {
      exitCode: errors.length === 0 ? 0 : 1,
      primaryError,
      errors: Object.freeze(errors),
    };
    // stopMs 是**排空耗时**（摘 handler 到 flush 完成），不是进程运行时长——名字取准，免得
    // 将来发现数字对不上还得改字段名（同请求日志的 handlerMs）。flush 算在窗口内是故意的：
    // 排空也是停的一部分。
    this.log({ stopMs: Date.now() - startedAt, exitCode: result.exitCode }, "stopped");
    this.stateValue = "finished";
    for (const acknowledge of this.acknowledgements.splice(0)) {
      acknowledge(result);
    }
    this.resolveCompletion(result);
    return result;
  }

  // logger 是用户的：绑定实现与 LogFieldSource.fields() 都可能抛。此刻关停已经没有回头路，
  // 一条日志故障不该改变 exitCode；但也不许静默（不变量 9），所以落回裸 stderr——那是日志
  // 系统自身故障的既定去处。
  //
  // 不做 isEnabled 前置判定：字段就是一个持有的字符串与一次减法，而且整个进程最多打两条；
  // 级别短路由 logger 自己在合并字段之前完成（不变量 8 的结构性保证）。
  private log(fields: Readonly<Record<string, unknown>> | undefined, message: string): void {
    if (this.logger === undefined) {
      return;
    }
    try {
      this.logger.info(fields, message);
    } catch (error) {
      process.stderr.write(`[reforce.shutdown] logger failed for "${message}": ${String(error)}\n`);
    }
  }
}

export function installProcessShutdownHandlers(controller: ShutdownController): void {
  const onMessage = (message: unknown) => {
    controller.receiveIpcMessage(message, (acknowledgement) => {
      process.send?.(acknowledgement);
    });
  };
  const onDisconnect = () => {
    void controller.requestShutdown(undefined, "parent-disconnect");
  };

  // 信号名此前被整个丢掉；现在只喂给关停日志的 trigger 字段。关停**路径**仍对
  // SIGINT / SIGTERM / SIGBREAK 一视同仁——分支判断没有因此多出来一个。
  const detachSignalHandlers = installTerminationSignalHandlers((signal) => {
    void controller.requestShutdown(undefined, signal);
  });
  process.on("message", onMessage);
  process.on("disconnect", onDisconnect);

  controller.setHandlerCleanup(() => {
    detachSignalHandlers();
    process.off("message", onMessage);
    process.off("disconnect", onDisconnect);
  });
}
