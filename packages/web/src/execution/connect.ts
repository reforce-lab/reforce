import type { ApplicationContext, BeanClass, BeanDefinition } from "@reforce/context";
import type { RequestSeeder, WebApplicationHandle, WebEngineAdapter } from "@/adapter";
import { createWebApplication, type RequestLogger } from "@/execution/web-application";

// 生成的 bootstrap 的 web 接线入口（ADR 0006 W1/W2 的 #153 修订，记录于 #142/#152 评论区）：
// 路由表与 ApplicationContext 只有生成代码同时拿得到，因此"把表交给引擎"发生在 bootstrap——
// 容器 start 完成后组装 WebApplication、逐个启动引擎 bean，返回包住容器的关闭编排：
// close = 先让全部引擎停止接新请求并排空在途请求（逆启动序），再走容器自身的关闭序。
// 引擎 bean 的 onContextClose 只是容器被直接 close 时的幂等兜底，正常路径由这里先行。

export interface ConnectWebApplicationOptions {
  readonly context: ApplicationContext;
  readonly table: unknown;
  // 引擎 bean 类（编译期从 starter meta 的 runtimeExport 识别，运行时经容器解析取实例，
  // 引擎的配置照常走构造注入）。数组顺序即启动顺序，关闭时逆序。
  readonly engines: readonly BeanClass<WebEngineAdapter>[];
  readonly requestSeeds?: RequestSeeder;
  /** 请求日志的 logger（RFC 0011 L6，#250）；由生成的 bootstrap 传入，缺席即不打。 */
  readonly logger?: RequestLogger;
}

async function closeStartedHandles(handles: readonly WebApplicationHandle[]): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const handle of handles.toReversed()) {
    try {
      await handle.close();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

function createWebShutdownContext(
  context: ApplicationContext,
  handles: readonly WebApplicationHandle[],
): ApplicationContext {
  let closing: Promise<void> | undefined;
  const closeInOrder = async (): Promise<void> => {
    const failures = await closeStartedHandles(handles);
    // 引擎排空失败也必须走完容器关闭序（否则进程保活句柄泄漏），失败在关闭完成后聚合上抛。
    await context.close();
    if (failures.length > 0) {
      throw new AggregateError(failures, "Web engine shutdown reported failures.");
    }
  };
  return {
    start: () => context.start(),
    get: <T extends object>(target: BeanClass<T> | BeanDefinition<T>): T => context.get(target),
    runInRequestScope: (seeds, callback) => context.runInRequestScope(seeds, callback),
    close: () => {
      closing ??= closeInOrder();
      return closing;
    },
  };
}

export async function connectWebApplication(
  options: ConnectWebApplicationOptions,
): Promise<ApplicationContext> {
  const { context, engines } = options;
  if (engines.length === 0) {
    return context;
  }
  const application = createWebApplication({
    table: options.table,
    context,
    ...(options.requestSeeds === undefined ? {} : { requestSeeds: options.requestSeeds }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  const handles: WebApplicationHandle[] = [];
  try {
    for (const engine of engines) {
      handles.push(await context.get(engine).start(application));
    }
  } catch (error) {
    // 启动半途失败：尽力回收已启动的引擎与容器，原始错误优先上抛（回收失败不遮蔽起因）。
    await closeStartedHandles(handles);
    try {
      await context.close();
    } catch {
      // 同上：保留原始启动错误
    }
    throw error;
  }
  return createWebShutdownContext(context, handles);
}
