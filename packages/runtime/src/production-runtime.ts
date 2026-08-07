import type { ApplicationContext } from "@reforce/core";
import { isObject } from "radashi";
import { installCrashTakeover } from "@/crash-takeover";
import type { FrameworkLogging } from "@/framework-logging";
import { createChildLeaseParticipant } from "@/lease-endpoint";
import { requireNodeExecutable } from "@/node-runtime";
import { PlainTextReporter, type Reporter, reportShutdownFailure } from "@/reporter";
import { installProcessShutdownHandlers, ShutdownController } from "@/shutdown-controller";

// Receiver half of the production-wire acknowledgement sent by start-command.ts. The dev wire's
// `DevChildLeaseParticipantAcknowledgement` (dev-ipc.ts) looks similar but carries an `ok` field;
// the production parent's ack has none (it only acks after a successful `addParticipant`), so
// this guard must not require `ok` — reusing the dev-ipc guard here would make every handshake
// time out.
interface LeaseParticipantAck {
  readonly type: "reforce:lease-participant-ack";
  readonly participantToken: string;
}

function isLeaseParticipantAck(
  value: unknown,
  participantToken: string,
): value is LeaseParticipantAck {
  return (
    isObject(value) &&
    Reflect.get(value, "type") === "reforce:lease-participant-ack" &&
    Reflect.get(value, "participantToken") === participantToken
  );
}

async function waitForParticipantAck(participantToken: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      process.off("message", onMessage);
      reject(new Error("The production parent did not acknowledge the lease participant."));
    }, 5_000);
    const onMessage = (message: unknown) => {
      if (!isLeaseParticipantAck(message, participantToken)) {
        return;
      }
      clearTimeout(timeout);
      process.off("message", onMessage);
      resolve();
    };
    process.on("message", onMessage);
  });
}

type ChildLeaseParticipant = Awaited<ReturnType<typeof createChildLeaseParticipant>>;

export interface ProductionApplicationDependencies {
  readonly reporter?: Reporter;
  // 生成的 bootstrap 的可选导出（RFC 0011 C2，#250）：那个模块是唯一同时拿得到框架 logger
  // 与 LoggerFactory 的地方，而它不认识 @reforce/runtime。取值函数而不是常量——进程级
  // handler 在 bootstrap 之前就装好，那一刻容器还不存在。没装日志绑定的应用它就是 undefined。
  readonly frameworkLogging?: () => FrameworkLogging | undefined;
}

async function joinParentLease(): Promise<ChildLeaseParticipant | undefined> {
  const leaseToken = process.env.REFORCE_LEASE_TOKEN;
  if (leaseToken === undefined) {
    return undefined;
  }
  if (typeof process.send !== "function") {
    throw new Error("A production child lease token requires Node.js process IPC.");
  }
  const participant = await createChildLeaseParticipant(leaseToken);
  try {
    process.send({ type: "reforce:lease-participant", participant: participant.participant });
    await waitForParticipantAck(participant.participant.participantToken);
    return participant;
  } catch (error) {
    try {
      await participant.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Production lease handshake failed and cleanup also failed.",
        { cause: error },
      );
    }
    throw error;
  }
}

export async function runProductionApplication(
  bootstrap: () => Promise<ApplicationContext>,
  dependencies: ProductionApplicationDependencies = {},
): Promise<void> {
  requireNodeExecutable();
  const reporter = dependencies.reporter ?? new PlainTextReporter();
  const controller = new ShutdownController({ command: "start", reporter });
  installProcessShutdownHandlers(controller);
  // 崩溃接管先于 bootstrap 安装：引导期崩溃是最没人看得见的一种。logger 只有容器起来之后
  // 才存在，所以「安装」与「接线」必然分两步（RFC 0011 C2，#250）。
  const crash = installCrashTakeover({ command: "start", reporter });
  let participant: ChildLeaseParticipant | undefined;
  await controller.start(async () => {
    participant = await joinParentLease();
    const application = await bootstrap();
    const logging = dependencies.frameworkLogging?.();
    if (logging !== undefined) {
      crash.attach(logging);
      controller.setLogger(logging.logger);
    }
    return { close: () => application.close() };
  });
  const result = await controller.finished;
  // 成功路径不 uninstall：participant.close() 期间崩了同样要被接管，反正进程正在退出。
  try {
    await participant?.close();
  } catch (error) {
    await reportShutdownFailure({
      reporter,
      command: "start",
      errors: [...result.errors, error],
    });
    process.exitCode = 1;
    return;
  }
  process.exitCode = result.exitCode;
}
