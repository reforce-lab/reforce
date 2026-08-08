import type { ApplicationContext, BeanClass, BeanDefinition } from "@reforce/core";
import type {
  RequestSeeder,
  WebApplicationHandle,
  WebEngineAdapter,
  WebEngineAddress,
} from "@/adapter";
import { createWebApplication, type RequestLogger } from "@/execution/web-application";

// 生成的 bootstrap 的 web 接线入口（ADR 0006 W1/W2 的 #153 修订，记录于 #142/#152 评论区）：
// 路由表与 ApplicationContext 只有生成代码同时拿得到，因此"把表交给引擎"发生在 bootstrap——
// 容器 start 完成后组装 WebApplication、逐个启动引擎 bean，返回包住容器的关闭编排：
// close = 先让全部引擎停止接新请求并排空在途请求（逆启动序），再走容器自身的关闭序。
// 引擎 bean 的 onContextClose 只是容器被直接 close 时的幂等兜底，正常路径由这里先行。

// 启动摘要里属于 web 的那一半（RFC 0011 D2，#250）：引擎名与实际监听地址、路由与 controller
// 数。另一半（bean 数、context start 耗时、ready in）只有生成的 bootstrap 知道，所以这里
// 只报事实、由 bootstrap 合成并发出——@reforce/web-core 因此不必认识 @reforce/logging。
export interface WebStartupFacts {
  readonly engines: readonly {
    readonly name: string;
    readonly address?: WebEngineAddress;
  }[];
  readonly routeCount: number;
  readonly controllerCount: number;
}

export interface ConnectWebApplicationOptions {
  readonly context: ApplicationContext;
  readonly table: unknown;
  // 引擎 bean 类（编译期从 starter meta 的 runtimeExport 识别，运行时经容器解析取实例，
  // 引擎的配置照常走构造注入）。数组顺序即启动顺序，关闭时逆序。
  readonly engines: readonly BeanClass<WebEngineAdapter>[];
  readonly requestSeeds?: RequestSeeder;
  /** 请求日志的 logger（RFC 0011 L6，#250）；由生成的 bootstrap 传入，缺席即不打。 */
  readonly logger?: RequestLogger;
  /** 全部引擎起来之后回调一次，交出启动摘要要的 web 侧事实。 */
  readonly onReady?: (facts: WebStartupFacts) => void;
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
    hasRequestScopedBeans: context.hasRequestScopedBeans,
    runInRequestScope: (seeds, callback, facts) =>
      context.runInRequestScope(seeds, callback, facts),
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
  const started: WebStartupFacts["engines"][number][] = [];
  try {
    for (const engine of engines) {
      const instance = context.get(engine);
      const handle = await instance.start(application);
      handles.push(handle);
      started.push({
        name: instance.name,
        ...(handle.address === undefined ? {} : { address: handle.address }),
      });
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
  // 摘要失败绝不能把一个已经起来的应用带下去：logger 是用户的，序列化与 fields() 都可能抛。
  try {
    options.onReady?.({
      engines: started,
      routeCount: application.routes.length,
      controllerCount: application.controllerCount,
    });
  } catch {
    // 摘要打不出就打不出，服务照常提供。
  }
  return createWebShutdownContext(context, handles);
}
