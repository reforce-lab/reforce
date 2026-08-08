import { compareUtf16CodeUnits } from "@reforce/primitives";
import { analyzeClassProvider } from "@/analysis/class-provider";
import { createExecutionPlans } from "@/analysis/execution-plan";
import { analyzeFactoryProvider } from "@/analysis/factory-provider";
import type { WeavingModel } from "@/analysis/interception-model";
import {
  contextFrameworkLoggerName,
  loggingPackageName,
  providedLoggerFactorySymbol,
  spanOfMetaSource,
  synthesizeLoggerBeans,
  webFrameworkLoggerName,
} from "@/analysis/logger-synthesis";
import { analyzeMethodInterception } from "@/analysis/method-interception";
import type {
  BeanProviderModel,
  ConfigProviderModel,
  ExecutionPlansModel,
  ProviderDraft,
  ProviderModel,
} from "@/analysis/model";
import { type PassContext, runContributePasses, runDiscoverPasses } from "@/analysis/pass";
import { createPassChannels } from "@/analysis/pass-channels";
import { analysisPasses } from "@/analysis/pass-registry";
import { resolveProviders } from "@/analysis/resolve-providers";
import { validateScopeRules } from "@/analysis/scope-rules";
import {
  transactionFrameworkLoggerName,
  transactionInterceptorBeanId,
  transactionInterceptorDraft,
  frameworkOriginId as transactionOriginId,
} from "@/analysis/transaction-weaving";
import { type WebModel, webEngineAdapterName, webPackageName } from "@/analysis/web-model";
import { analyzeWebRoutes } from "@/analysis/web-routes";
import type { CompilerDiagnostic } from "@/api";
import { diagnostic, hasErrorDiagnostic, orderDiagnostics } from "@/diagnostics";
import type { ProjectLinker } from "@/linking/project-linker";
import type { ClassDeclaration } from "@/parser/source-ir";
import type { ParsedSource } from "@/project/source-files";
import type { TypeQuery } from "@/typescript/type-query";

interface AnalysisSuccess {
  readonly status: "success";
  // 分析成功也可能有话要说：这里的诊断全是 warning（RFC 0011 OM2，#242）。
  readonly diagnostics: readonly CompilerDiagnostic[];
  readonly providers: readonly BeanProviderModel[];
  readonly configs: readonly ConfigProviderModel[];
  readonly plans: ExecutionPlansModel;
  readonly web: WebModel;
  readonly weaving: WeavingModel;
}

interface AnalysisFailure {
  readonly status: "failure";
  readonly diagnostics: readonly [CompilerDiagnostic, ...CompilerDiagnostic[]];
}

type AnalysisResult = AnalysisSuccess | AnalysisFailure;

function nonEmptyDiagnostics(
  diagnostics: readonly CompilerDiagnostic[],
): readonly [CompilerDiagnostic, ...CompilerDiagnostic[]] {
  const first = diagnostics[0];
  if (first === undefined) {
    throw new Error("Expected at least one diagnostic");
  }
  return [first, ...diagnostics.slice(1)];
}

function validateModuleSyntax(
  sources: readonly ParsedSource[],
  diagnostics: CompilerDiagnostic[],
): void {
  for (const source of sources) {
    for (const declaration of [...source.unit.imports, ...source.unit.exports]) {
      if (declaration.kind !== "unsupported-import" && declaration.kind !== "unsupported-export") {
        continue;
      }
      diagnostics.push(
        diagnostic({
          code: "UNSUPPORTED_MODULE_SYNTAX",
          message: `Module syntax ${declaration.syntaxKind} is not supported by the first production compiler.`,
          sourceSpan: declaration.span,
          help: "Use standard ESM import and export declarations without import attributes.",
        }),
      );
    }
  }
}

function sourceProviderDrafts(
  source: ParsedSource,
  linker: ProjectLinker,
  diagnostics: CompilerDiagnostic[],
  claimedByConfig: ReadonlySet<ClassDeclaration>,
): readonly ProviderDraft[] {
  // config 分析已认领的 class（含形状非法的 config 声明）不再作为普通 provider 复查，
  // 否则同一个类会拿到两套互相矛盾的诊断。
  const classDrafts = source.unit.classes
    .filter((declaration) => !claimedByConfig.has(declaration))
    .map((declaration) => {
      const draft = analyzeClassProvider(source, declaration, linker, diagnostics);
      rejectApplicationFallback(draft, declaration, diagnostics);
      return draft;
    });
  const factoryDrafts = source.unit.beanFactories.map((declaration) =>
    analyzeFactoryProvider(source, declaration, linker, diagnostics),
  );
  return [...classDrafts, ...factoryDrafts].filter((draft) => draft !== undefined);
}

// @Fallback() 只在 starter 包里有意义（#343）：它归一为 meta 的 defaultBean，而应用侧的候选
// 裁决只认 starter 的 defaultBean（resolve-providers 的两处 filter）。本文件是应用编译独占的
// 路径——库编译走 library/compile.ts 自己的采集循环，不经过这里——所以拦在这儿既拦得住误用，
// 又不影响 starter 作者正常使用。放过去的后果是注解看着能用、写了没反应，比报错难查得多。
function rejectApplicationFallback(
  draft: ProviderDraft | undefined,
  declaration: ClassDeclaration,
  diagnostics: CompilerDiagnostic[],
): void {
  if (draft?.provider.fallback !== true) {
    return;
  }
  diagnostics.push(
    diagnostic({
      code: "INVALID_DECORATOR_USAGE",
      message: `Fallback cannot mark ${declaration.name ?? "an anonymous class"} in an application: it only means anything in a starter package.`,
      sourceSpan: declaration.span,
      help: "Remove Fallback, or move this class into a starter package built with `reforce lib`.",
    }),
  );
}

function collectProviderDrafts(
  sources: readonly ParsedSource[],
  linker: ProjectLinker,
  diagnostics: CompilerDiagnostic[],
  claimedByConfig: ReadonlySet<ClassDeclaration>,
): readonly ProviderDraft[] {
  return sources
    .filter((source) => !source.sourceKind.startsWith("d."))
    .flatMap((source) => sourceProviderDrafts(source, linker, diagnostics, claimedByConfig));
}

function isBeanProvider(provider: ProviderModel): provider is BeanProviderModel {
  return provider.kind !== "config";
}

// typeQuery(RFC 0012 S1 接入,#273;S2 消费,#274):checker 门面沿管线时序在
// createProjectLinker 之后就位,web 槽位解析按需查询——lease 懒 spawn,全仓无槽位查询
// 则 tsgo 不起。
export function analyzeProject(
  sources: readonly ParsedSource[],
  linker: ProjectLinker,
  typeQuery?: TypeQuery,
): AnalysisResult {
  const diagnostics: CompilerDiagnostic[] = [];
  validateModuleSyntax(sources, diagnostics);
  // pass 相位（#344 定案 1）：discover 只吃 (sources, linker)，产 draft、写通道；它的下游
  // collectProviderDrafts 读 claimedDeclarations。相位内的执行序就是 analysisPasses 的下标序。
  const channels = createPassChannels();
  const passContext: PassContext = { sources, linker, diagnostics, typeQuery };
  const discovered = runDiscoverPasses(analysisPasses, passContext, channels);
  const drafts = collectProviderDrafts(sources, linker, diagnostics, channels.claimedDeclarations);

  // web 引擎约定（ADR 0006 W2 的 #153 接线，见 web-model.ts）：提供 @reforce/web-core 的
  // WebEngineAdapter 契约的 starter bean 由生成的 bootstrap 消费，先于 resolveProviders
  // 识别出来，作为显式需求物化——它的需求方是生成代码，不在任何依赖边上。
  const engineBeans = linker.starterLinkage.beans.filter((bean) =>
    bean.provides.some(
      (contract) =>
        contract.external?.packageName === webPackageName && contract.name === webEngineAdapterName,
    ),
  );
  // 事务拦截器合成注册（ADR 0008 AM2，#204 定案 6）：检测到 @Transactional 方法使用即入表，
  // 它对 TransactionManager 契约的依赖走下面的正常解析——有使用无实现在编译期就是 MISSING_BEAN。
  // 探针集合刻意不含事务 draft 自己：拦截器的 provides 只有 TransactionInterceptor，它永远
  // 提供不了 LoggerFactory，所以答案与 synthesizeLoggerBeans 过去在内部算的完全一致。
  // 不写这条注释的话，后来人会以为这是个顺序 bug 而去「修」它。
  const loggerBinding = providedLoggerFactorySymbol([...discovered, ...drafts], linker);
  const transactionDraft = transactionInterceptorDraft(
    sources,
    linker,
    loggerBinding !== undefined,
  );
  const applicationDrafts = [
    ...discovered,
    ...drafts,
    ...(transactionDraft === undefined ? [] : [transactionDraft]),
  ];
  // logger bean 合成（RFC 0011 L2，#242）：与事务拦截器同一时机——collectProviderDrafts 之后、
  // resolveProviders 之前。它要看全部 draft 的 pendingDependencies 才知道有哪些 logger 名，
  // 又必须赶在解析开始前把自己的 draft 放进表里。
  // 框架自己那条 logger（RFC 0011 L6/L8，#250）：请求日志与引擎监听行都从它出，需求方是生成的
  // bootstrap，同样不在任何依赖边上。它是本地 draft 而不是 starter bean，所以不走
  // demandedBeanIds——本地 draft 一律入图。装了引擎但没装任何日志绑定时不合成，见 synthesize。
  const loggers = synthesizeLoggerBeans({
    drafts: applicationDrafts,
    loggerFactory: loggerBinding?.symbol,
    diagnostics,
    frameworkLoggers: [
      // 容器面那条恒在（RFC 0011 L6【已定】）：启动摘要、bean 台账、关停与崩溃都是容器的
      // 事实，job / CLI / worker 这类没有引擎的应用同样要有。它的「为什么在图里」就是那处
      // LoggerFactory 绑定——没有绑定时 synthesizeLoggerBeans 整个不合成，见那边的注释。
      ...(loggerBinding === undefined
        ? []
        : [
            {
              name: contextFrameworkLoggerName,
              reason: loggingPackageName,
              span: loggerBinding.span,
            },
          ]),
      ...engineBeans.slice(0, 1).map((bean) => ({
        name: webFrameworkLoggerName,
        reason: webPackageName,
        span: spanOfMetaSource(bean.metaSource),
      })),
      // 事务那条与 web 那条的区别只在消费方式：web 由生成的 bootstrap 直接 get，事务是
      // 拦截器的第 1 个构造参数，所以要带上 consumer 让重定向表接上那条边。
      ...(transactionDraft === undefined
        ? []
        : [
            {
              name: transactionFrameworkLoggerName,
              reason: transactionOriginId,
              span: transactionDraft.span,
              consumer: { beanId: transactionInterceptorBeanId, parameterIndex: 1 },
            },
          ]),
    ],
  });
  // contribute 相位（#344 定案 1）：吃全量 draft、读写通道、再产 draft。事务与 logging 迁进来
  // 之前它没有成员，此处是空转——驱动先就位，后续两步才是纯注册变更。
  const contributed = runContributePasses(
    analysisPasses,
    passContext,
    [...applicationDrafts, ...loggers.drafts],
    channels,
  );
  const localDrafts = [...contributed];
  // starter 契约解析仍会经 binder 推新的 linker 诊断，所以 linker.diagnostics 必须在
  // resolveProviders 之后再并入；顺序无所谓，最终由 orderDiagnostics 排序去重。
  const starterDrafts = resolveProviders(
    localDrafts,
    linker.starterLinkage,
    diagnostics,
    new Set(engineBeans.map((bean) => bean.id)),
    loggers.redirects,
    loggers.levelsBeanId,
  );
  // 物化集合即可达子图（ADR 0004 决策 11，#120）：未被需求的 starter bean 从未成为 draft，
  // 执行计划照旧在全量 providers 上排序，确定性排序保证不变。config 不进执行计划——它由
  // 绑定 phase 先于一切 bean 构造（ADR 0005 决策 6.1），指向 config 的 eager 边视为恒就绪。
  const allProviders = [...localDrafts, ...starterDrafts]
    .map((draft) => draft.provider)
    .toSorted((left, right) => compareUtf16CodeUnits(left.id, right.id));
  // 跨作用域裸边与请求内环（ADR 0006 W7）要看已解析的双侧 scope，必须排在 resolveProviders 之后。
  validateScopeRules(allProviders, diagnostics);
  // 路由提取要在 provider 全集就位后进行：controller/中间件/错误处理器的 bean 身份与
  // scope 校验都以最终 provider 表为准（ADR 0006 W3/W4，#152）。
  const web = analyzeWebRoutes(sources, linker, allProviders, diagnostics, engineBeans, typeQuery);
  // 织入分析同样要求完整 provider 表（ADR 0008 AM1，#202），且必须先于 createExecutionPlans：
  // 它把每个被织 bean 的拦截器作为构造依赖边追加进 provider.dependencies，构造排序、
  // cycle-proxy 改写与 request 计划全部沿既有机制生效。拦截器被强制为 singleton，追加边
  // 不会引入新的跨作用域形态，validateScopeRules 先跑不受影响。
  const weaving = analyzeMethodInterception(sources, linker, allProviders, diagnostics);
  diagnostics.push(...linker.diagnostics);

  // 闸门只看 error：有 error 说明 provider 表不完整，继续走 emission 会生成实参缺失的构造
  // 调用；warning 不影响图的完整性，随 success 一起返回（RFC 0011 OM2，#242）。
  if (hasErrorDiagnostic(diagnostics)) {
    return { status: "failure", diagnostics: nonEmptyDiagnostics(diagnostics) };
  }
  const providers = allProviders.filter(isBeanProvider);
  const configs = allProviders.flatMap((provider) =>
    provider.kind === "config" ? [provider] : [],
  );
  return {
    status: "success",
    diagnostics: Object.freeze(orderDiagnostics(diagnostics)),
    providers: Object.freeze(providers),
    configs: Object.freeze(configs),
    plans: createExecutionPlans(providers, new Set(configs.map((config) => config.id))),
    web,
    weaving,
  };
}
