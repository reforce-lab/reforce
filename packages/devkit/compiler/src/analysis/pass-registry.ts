import { analyzeConfigProviders } from "@/analysis/config-provider";
import {
  contextFrameworkLoggerName,
  loggingPackageName,
  providedLoggerFactorySymbol,
  spanOfMetaSource,
  synthesizeLoggerBeans,
  webFrameworkLoggerName,
} from "@/analysis/logger-synthesis";
import type { ContributePass, DiscoverPass, PassRegistry } from "@/analysis/pass";
import {
  transactionalMarkerKey,
  transactionFrameworkLoggerName,
  transactionInterceptorBeanId,
  transactionInterceptorDraft,
  transactionInterceptorSymbol,
  frameworkOriginId as transactionOriginId,
} from "@/analysis/transaction-weaving";
import { webEngineAdapterName, webPackageName } from "@/analysis/web-model";

// pass 注册表（#344 定案 4）：`as const` 数组字面量，**执行序即下标序**。
//
// 禁止按名字或包名动态排序、禁止迭代 Map 决定顺序——那样两次编译的 pass 顺序就不再由源码
// 唯一决定，而「生成物逐字节可复现」这条不变量正建立在它之上。顺序的正确性由
// `test/analysis/pass-registry.spec.ts` 的断言 A（每条通道的 reader 下标 > writer 下标）
// 静态核实，不靠人记住。
//
// 迁移顺序按定案的实施路径走，config 是第一个：347 行、纯 discover、只输出 claimed + drafts、
// 零通道读，是唯一能在不触碰任何时序注释的前提下搬完的 pass。

const configPass: DiscoverPass = {
  name: "config",
  phase: "discover",
  reads: [],
  writes: ["claimedDeclarations"],
  run(context, out) {
    const analysis = analyzeConfigProviders(context.sources, context.linker, context.diagnostics);
    for (const declaration of analysis.claimed) {
      out.claimedDeclarations.add(declaration);
    }
    return analysis.drafts;
  },
};

// web 引擎约定（ADR 0006 W2 的 #153 接线，见 web-model.ts）：提供 @reforce/web-core 的
// WebEngineAdapter 契约的 starter bean 由生成的 bootstrap 消费，先于 resolveProviders 识别出来
// 作为显式需求物化——它的需求方是生成代码，不在任何依赖边上。
//
// 它与 web-routes 是同一个领域的两个 pass（定案 1：一个领域可以注册多个 pass）：探测属
// discover，路由提取属 refine，中间隔着 resolveProviders 这个核心步，不可能塞进同一个 pass。
const webEnginePass: DiscoverPass = {
  name: "web-engine",
  phase: "discover",
  reads: [],
  writes: ["engineBeans", "demandedBeanIds", "frameworkLoggers"],
  run(context, out) {
    const beans = context.linker.starterLinkage.beans.filter((bean) =>
      bean.provides.some(
        (contract) =>
          contract.external?.packageName === webPackageName &&
          contract.name === webEngineAdapterName,
      ),
    );
    out.engineBeans.push(...beans);
    for (const bean of beans) {
      out.demandedBeanIds.add(bean.id);
    }
    // 框架自己那条 web logger（RFC 0011 L6/L8，#250）：请求日志与引擎监听行都从它出，需求方
    // 同样是生成的 bootstrap。只取首个引擎——同名 logger 一条就够，多引擎共用它。
    for (const bean of beans.slice(0, 1)) {
      out.frameworkLoggers.push({
        name: webFrameworkLoggerName,
        reason: webPackageName,
        span: spanOfMetaSource(bean.metaSource),
      });
    }
    return [];
  },
};

// 事务拦截器合成注册（ADR 0008 AM2，#204 定案 6）：检测到 @Transactional 方法使用即入表，它对
// TransactionManager 契约的依赖走后面的正常解析——有使用无实现在编译期就是 MISSING_BEAN。
//
// 它必须是 contribute 而不是 discover：`loggerAvailable` 要看**全部** draft 里有没有人提供
// LoggerFactory，那份全貌只有 collectProviderDrafts 之后才有。
//
// 探针集合刻意不含事务 draft 自己（此处 drafts 参数就是 contribute 的输入，事务 draft 尚未
// 产出）：拦截器的 provides 只有 TransactionInterceptor，它永远提供不了 LoggerFactory，所以
// 答案与收敛前 analyze-project 在同一位置算出来的完全一致。不写这条的话，后来人会以为这是个
// 顺序 bug 而去「修」它。
const transactionPass: ContributePass = {
  name: "transaction",
  phase: "contribute",
  reads: [],
  writes: ["frameworkLoggers", "interceptorBindings"],
  run(context, drafts, out) {
    const loggerAvailable = providedLoggerFactorySymbol(drafts, context.linker) !== undefined;
    const draft = transactionInterceptorDraft(context.sources, context.linker, loggerAvailable);
    if (draft === undefined) {
      return [];
    }
    // 事务那条框架 logger 与 web 那条的区别只在消费方式：web 由生成的 bootstrap 直接 get，
    // 事务是拦截器的第 1 个构造参数，所以要带上 consumer 让重定向表接上那条边。
    out.frameworkLoggers.push({
      name: transactionFrameworkLoggerName,
      reason: transactionOriginId,
      span: draft.span,
      consumer: { beanId: transactionInterceptorBeanId, parameterIndex: 1 },
    });
    // 收敛前这条是 method-interception 里的跨文件硬编码（`providerById.has(...)` 再就地拼
    // 绑定）。phase "transaction"、order 0 是 AM1 阶段表为它预留的唯一落位。
    out.interceptorBindings.push({
      beanId: transactionInterceptorBeanId,
      phase: "transaction",
      order: 0,
      markerKey: transactionalMarkerKey,
      contract: transactionInterceptorSymbol,
    });
    return [draft];
  },
};

// logger bean 合成（RFC 0011 L2，#242）：它要看全部 draft 的 pendingDependencies 才知道有哪些
// logger 名，又必须赶在解析开始前把自己的 draft 放进表里——contribute 相位正是这两条的交集。
//
// 容器面那条 logger 恒在（RFC 0011 L6【已定】）：启动摘要、bean 台账、关停与崩溃都是容器的
// 事实，job / CLI / worker 这类没有引擎的应用同样要有。它的「为什么在图里」就是那处
// LoggerFactory 绑定——没有绑定时 synthesizeLoggerBeans 整个不合成，见那边的注释。所以它由
// logging 自己按绑定现算，不占 frameworkLoggers 通道的一格。
//
// frameworkLoggers 消费前按 name 排序（定案 4 断言 B）：applyFrameworkDemands 是写入序
// first-wins，收敛前「web 排在 transaction 前面」纯属注册顺序的巧合，不能让它变成契约。
// 三条 logger 名互不相同，排序对结果无影响，排的是「顺序不可观测」这条性质本身。
const loggingPass: ContributePass = {
  name: "logging",
  phase: "contribute",
  reads: ["frameworkLoggers"],
  writes: ["resolutionOverrides"],
  run(context, drafts, out) {
    const binding = providedLoggerFactorySymbol(drafts, context.linker);
    const frameworkLoggers = [
      ...(binding === undefined
        ? []
        : [{ name: contextFrameworkLoggerName, reason: loggingPackageName, span: binding.span }]),
      ...out.frameworkLoggers.toSorted((left, right) => (left.name < right.name ? -1 : 1)),
    ];
    const loggers = synthesizeLoggerBeans({
      drafts,
      loggerFactory: binding?.symbol,
      diagnostics: context.diagnostics,
      frameworkLoggers,
    });
    for (const [from, to] of loggers.redirects) {
      out.resolutionOverrides.redirects.set(from, to);
    }
    out.resolutionOverrides.levelsBeanId = loggers.levelsBeanId;
    return loggers.drafts;
  },
};

export const analysisPasses = [
  configPass,
  webEnginePass,
  transactionPass,
  loggingPass,
] as const satisfies PassRegistry;
