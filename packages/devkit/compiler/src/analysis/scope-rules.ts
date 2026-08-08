import { alg, Graph } from "@dagrejs/graphlib";
import { compareUtf16CodeUnits } from "@reforce/primitives";
import {
  type CollectionDependencyModel,
  isCollectionDependency,
  type ProviderModel,
  type SingleDependencyModel,
} from "@/analysis/model";
import type { CompilerDiagnostic } from "@/api";
import { diagnostic } from "@/diagnostics";
import type { SourceSpan } from "@/parser/source-location";

// 跨作用域边的静态分类（ADR 0006 W7，#142 / #151）：作用域不传染是不变量——singleton 持有的
// 只能是 Current<T> 句柄，裸边（eager/Lazy/集合成员）一律编译期硬错、双侧定位；反方向
// request→singleton 完全合法。请求子图不设 cycle proxy，请求内依赖环同样在这里拦下，
// 保证 requestConstructionOrder 恒可排。

type DiagnosticRelatedInformation = CompilerDiagnostic["related"][number];

function providerSpan(provider: ProviderModel): SourceSpan | undefined {
  if (provider.origin.kind !== "application") {
    return undefined;
  }
  return {
    fileId: provider.origin.source.fileId,
    start: provider.declarationSource.start,
    end: provider.declarationSource.end,
  };
}

function dependencySpan(
  provider: ProviderModel,
  dependency: SingleDependencyModel | CollectionDependencyModel,
): SourceSpan | undefined {
  if (provider.origin.kind !== "application") {
    return undefined;
  }
  // 应用侧依赖边的 span 与其 provider 声明同文件（构造参数就在类声明里），借 provider 的
  // 品牌化 fileId 定位；starter 侧无应用内 span，交给 related 的 id 文本定位。
  return {
    fileId: provider.origin.source.fileId,
    start: dependency.source.start,
    end: dependency.source.end,
  };
}

function bothSidesRelated(
  consumer: ProviderModel,
  target: ProviderModel,
): readonly DiagnosticRelatedInformation[] {
  return [
    { message: `consumer ${consumer.id}`, sourceSpan: providerSpan(consumer) },
    { message: `request-scoped target ${target.id}`, sourceSpan: providerSpan(target) },
  ];
}

function validateCurrentEdge(
  consumer: ProviderModel,
  dependency: SingleDependencyModel,
  target: ProviderModel | undefined,
  diagnostics: CompilerDiagnostic[],
): void {
  if (consumer.scope === "request") {
    diagnostics.push(
      diagnostic({
        code: "INVALID_CURRENT_INJECTION",
        message: `Request-scoped ${consumer.id} injects a Current handle; request Beans read request state directly.`,
        sourceSpan: dependencySpan(consumer, dependency),
        help: "Inject the contract directly without the Current wrapper.",
      }),
    );
    return;
  }
  if (target === undefined || target.scope === "request") {
    return;
  }
  diagnostics.push(
    diagnostic({
      code: "INVALID_CURRENT_INJECTION",
      message: `Current dependency ${dependency.parameterIndex} of ${consumer.id} targets ${target.id}, which is not request-scoped.`,
      sourceSpan: dependencySpan(consumer, dependency),
      related: [{ message: target.id, sourceSpan: providerSpan(target) }],
      help: "Inject the contract directly; Current only bridges a singleton into request state.",
    }),
  );
}

function validateSingleEdge(
  consumer: ProviderModel,
  dependency: SingleDependencyModel,
  providerById: ReadonlyMap<string, ProviderModel>,
  diagnostics: CompilerDiagnostic[],
): void {
  const target = providerById.get(dependency.targetId);
  if (dependency.mode === "current") {
    validateCurrentEdge(consumer, dependency, target, diagnostics);
    return;
  }
  if (target?.scope !== "request") {
    return;
  }
  if (consumer.scope === "singleton") {
    const edgeKind = dependency.mode === "explicit-lazy" ? "a Lazy edge" : "a bare edge";
    diagnostics.push(
      diagnostic({
        code: "INVALID_REQUEST_SCOPE_DEPENDENCY",
        message: `Singleton ${consumer.id} depends on request-scoped ${target.id} through ${edgeKind}.`,
        sourceSpan: dependencySpan(consumer, dependency),
        related: bothSidesRelated(consumer, target),
        help: "Inject Current<T> and call .get() during a request: scopes never leak into a singleton.",
      }),
    );
    return;
  }
  if (dependency.mode === "explicit-lazy") {
    diagnostics.push(
      diagnostic({
        code: "INVALID_REQUEST_SCOPE_DEPENDENCY",
        message: `Request-scoped ${consumer.id} injects Lazy onto request-scoped ${target.id}, which is not supported yet.`,
        sourceSpan: dependencySpan(consumer, dependency),
        related: bothSidesRelated(consumer, target),
        help: "Inject the request Bean directly: the request plan already defers construction per request.",
      }),
    );
  }
}

function validateCollectionEdge(
  consumer: ProviderModel,
  dependency: CollectionDependencyModel,
  providerById: ReadonlyMap<string, ProviderModel>,
  diagnostics: CompilerDiagnostic[],
): void {
  for (const member of dependency.members) {
    const target = providerById.get(member.targetId);
    if (target?.scope !== "request") {
      continue;
    }
    diagnostics.push(
      diagnostic({
        code: "INVALID_REQUEST_SCOPE_DEPENDENCY",
        message: `Collection dependency ${dependency.parameterIndex} of ${consumer.id} would include request-scoped ${target.id}.`,
        sourceSpan: dependencySpan(consumer, dependency),
        related: bothSidesRelated(consumer, target),
        help: "Collections are singleton-only: keep the request-scoped Bean out of the shared contract.",
      }),
    );
  }
}

// 请求内环检测：请求计划没有 cycle proxy（每请求的代理身份无处缓存，且计划驱动构造不允许
// "先给半成品"），环内成员一律硬错。只看 request→request 的 eager 边；指向 singleton/config
// 的边对请求计划恒就绪，不参与环。
function reportRequestCycles(
  providers: readonly ProviderModel[],
  diagnostics: CompilerDiagnostic[],
): void {
  const requestProviders = providers.filter((provider) => provider.scope === "request");
  const requestIds = new Set(requestProviders.map((provider) => provider.id));
  const providerById = new Map(requestProviders.map((provider) => [provider.id, provider]));
  const graph = new Graph({ directed: true });
  for (const provider of requestProviders) {
    graph.setNode(provider.id);
    for (const dependency of provider.dependencies) {
      if (isCollectionDependency(dependency) || dependency.mode !== "eager") {
        continue;
      }
      if (requestIds.has(dependency.targetId)) {
        graph.setEdge(provider.id, dependency.targetId);
      }
    }
  }
  const cycles = alg
    .tarjan(graph)
    .map((members) => members.toSorted(compareUtf16CodeUnits))
    .filter((members) => {
      const single = members[0];
      return members.length > 1 || (single !== undefined && graph.hasEdge(single, single));
    })
    .toSorted((left, right) => compareUtf16CodeUnits(left[0] ?? "", right[0] ?? ""));
  for (const members of cycles) {
    const first = members[0];
    const firstProvider = first === undefined ? undefined : providerById.get(first);
    diagnostics.push(
      diagnostic({
        code: "REQUEST_DEPENDENCY_CYCLE",
        message: `Request-scoped construction cannot order a dependency cycle: ${members.join(" -> ")}.`,
        sourceSpan: firstProvider === undefined ? undefined : providerSpan(firstProvider),
        related: members.map((id) => {
          const member = providerById.get(id);
          return {
            message: id,
            sourceSpan: member === undefined ? undefined : providerSpan(member),
          };
        }),
        help: "Break the cycle: the request plan constructs strictly dependency-first and request Beans have no cycle proxies.",
      }),
    );
  }
}

export function validateScopeRules(
  providers: readonly ProviderModel[],
  diagnostics: CompilerDiagnostic[],
): void {
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  for (const provider of providers) {
    for (const dependency of provider.dependencies) {
      if (isCollectionDependency(dependency)) {
        validateCollectionEdge(provider, dependency, providerById, diagnostics);
        continue;
      }
      validateSingleEdge(provider, dependency, providerById, diagnostics);
    }
  }
  reportRequestCycles(providers, diagnostics);
}
