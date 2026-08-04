import { alg, Graph } from "@dagrejs/graphlib";
import { compareUtf16CodeUnits } from "@reforce/primitives";
import type { ExecutionPlansModel } from "@/analysis/model";

// 计划层的结构化输入（与 analysis/model 的 DependencyModel 结构兼容）：环标记要就地改写
// mode，边必须是模型对象本身——单边即依赖对象，集合边展开为各成员对象（#150）。
interface PlanSingleDependency {
  readonly parameterIndex: number;
  readonly targetId: string;
  mode: "eager" | "cycle-proxy" | "explicit-lazy";
}

interface PlanCollectionMember {
  readonly targetId: string;
  mode: "eager" | "cycle-proxy";
}

interface PlanCollectionDependency {
  readonly parameterIndex: number;
  readonly members: readonly PlanCollectionMember[];
}

type PlanDependency = PlanSingleDependency | PlanCollectionDependency;
type PlanEdge = PlanSingleDependency | PlanCollectionMember;

interface PlanEdgeRef {
  readonly parameterIndex: number;
  readonly edge: PlanEdge;
}

interface PlanProviderBase {
  readonly id: string;
  readonly dependencies: readonly PlanDependency[];
}
type PlanProvider =
  | (PlanProviderBase & {
      readonly kind: "class";
      readonly startHook: boolean;
      readonly closeHook: boolean;
    })
  | (PlanProviderBase & {
      readonly kind: "factory";
      readonly dispose: boolean;
    });

function planEdges(provider: PlanProvider): readonly PlanEdgeRef[] {
  return provider.dependencies.flatMap((dependency): readonly PlanEdgeRef[] =>
    "members" in dependency
      ? dependency.members.map((member) => ({
          parameterIndex: dependency.parameterIndex,
          edge: member,
        }))
      : [{ parameterIndex: dependency.parameterIndex, edge: dependency }],
  );
}

function orderedEdges(provider: PlanProvider, includeDelayed: boolean): readonly PlanEdgeRef[] {
  return planEdges(provider)
    .filter((reference) => includeDelayed || reference.edge.mode === "eager")
    .toSorted((left, right) => {
      const target = compareUtf16CodeUnits(left.edge.targetId, right.edge.targetId);
      return target === 0 ? left.parameterIndex - right.parameterIndex : target;
    });
}

function markCycleProxyEdges(providers: readonly PlanProvider[]): void {
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  for (const component of stronglyConnectedComponents(providers, false)) {
    const members = new Set(component.members);
    const state = new Map<string, "active" | "complete">();

    function visitEdge(edge: PlanEdge): void {
      if (!members.has(edge.targetId)) {
        return;
      }
      const targetState = state.get(edge.targetId);
      if (targetState === undefined) {
        visit(edge.targetId);
        return;
      }
      if (targetState === "active") {
        edge.mode = "cycle-proxy";
      }
    }

    function visit(id: string): void {
      state.set(id, "active");
      const provider = providerById.get(id);
      if (provider === undefined) {
        state.set(id, "complete");
        return;
      }
      for (const reference of orderedEdges(provider, false)) {
        visitEdge(reference.edge);
      }
      state.set(id, "complete");
    }

    for (const id of component.members) {
      if (state.get(id) === undefined) {
        visit(id);
      }
    }
  }
}

function dependencyFirstOrder(
  providers: readonly PlanProvider[],
  includeDelayed: boolean,
  alwaysReady: ReadonlySet<string>,
): readonly string[] {
  const dependencies = new Map(
    providers.map((provider) => [
      provider.id,
      new Set(orderedEdges(provider, includeDelayed).map((reference) => reference.edge.targetId)),
    ]),
  );
  return globallyReadyOrder(
    providers.map((provider) => provider.id),
    dependencies,
    alwaysReady,
  );
}

function globallyReadyOrder(
  keys: readonly string[],
  dependencies: ReadonlyMap<string, ReadonlySet<string>>,
  alwaysReady: ReadonlySet<string> = new Set(),
): readonly string[] {
  const pending = keys.toSorted(compareUtf16CodeUnits);
  // config 实例由启动期绑定 phase 先于构造循环产生（ADR 0005 决策 6.1），指向它们的边
  // 在任何计划位置都已满足。
  const emitted = new Set<string>(alwaysReady);
  const output: string[] = [];
  while (pending.length > 0) {
    const readyIndex = pending.findIndex((key) =>
      [...(dependencies.get(key) ?? [])].every((dependency) => emitted.has(dependency)),
    );
    if (readyIndex === -1) {
      throw new Error("Dependency graph contains no ready item.");
    }
    const [ready] = pending.splice(readyIndex, 1);
    if (ready === undefined) {
      throw new Error("Ready dependency disappeared before it could be emitted.");
    }
    emitted.add(ready);
    output.push(ready);
  }
  return output;
}

interface Component {
  readonly members: readonly string[];
  readonly key: string;
}

function dependencyGraph(providers: readonly PlanProvider[], includeDelayed: boolean): Graph {
  const graph = new Graph({ directed: true });
  for (const provider of providers.toSorted((left, right) =>
    compareUtf16CodeUnits(left.id, right.id),
  )) {
    graph.setNode(provider.id);
    for (const reference of orderedEdges(provider, includeDelayed)) {
      graph.setEdge(provider.id, reference.edge.targetId);
    }
  }
  return graph;
}

function stronglyConnectedComponents(
  providers: readonly PlanProvider[],
  includeDelayed: boolean,
): readonly Component[] {
  return alg
    .tarjan(dependencyGraph(providers, includeDelayed))
    .flatMap((members) => {
      const orderedMembers = members.toSorted(compareUtf16CodeUnits);
      const key = orderedMembers[0];
      return key === undefined ? [] : [{ members: orderedMembers, key }];
    })
    .toSorted((left, right) => compareUtf16CodeUnits(left.key, right.key));
}

function lifecycleOrder(providers: readonly PlanProvider[]): readonly string[] {
  const components = stronglyConnectedComponents(providers, true);
  const componentByMember = new Map<string, Component>();
  for (const component of components) {
    for (const member of component.members) {
      componentByMember.set(member, component);
    }
  }
  const dependencies = new Map<string, Set<string>>();
  for (const provider of providers) {
    const consumerComponent = componentByMember.get(provider.id);
    if (consumerComponent === undefined) {
      continue;
    }
    const targets = dependencies.get(consumerComponent.key) ?? new Set<string>();
    dependencies.set(consumerComponent.key, targets);
    for (const reference of planEdges(provider)) {
      const targetComponent = componentByMember.get(reference.edge.targetId);
      if (targetComponent !== undefined && targetComponent.key !== consumerComponent.key) {
        targets.add(targetComponent.key);
      }
    }
  }

  const componentByKey = new Map(components.map((component) => [component.key, component]));
  return globallyReadyOrder(
    components.map((component) => component.key),
    dependencies,
  ).flatMap((key) => componentByKey.get(key)?.members ?? []);
}

export function createExecutionPlans(
  providers: readonly PlanProvider[],
  alwaysReady: ReadonlySet<string> = new Set(),
): ExecutionPlansModel {
  markCycleProxyEdges(providers);
  const constructionOrder = dependencyFirstOrder(providers, false, alwaysReady);
  const fullLifecycleOrder = lifecycleOrder(providers);
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const startActionOrder = fullLifecycleOrder.filter((id) => {
    const provider = providerById.get(id);
    return provider?.kind === "class" && provider.startHook;
  });
  const cleanupActionOrder = [...fullLifecycleOrder].reverse().filter((id) => {
    const provider = providerById.get(id);
    return provider?.kind === "class" ? provider.closeHook : provider?.dispose === true;
  });
  return Object.freeze({
    constructionOrder: Object.freeze(constructionOrder),
    startActionOrder: Object.freeze(startActionOrder),
    cleanupActionOrder: Object.freeze(cleanupActionOrder),
  });
}
