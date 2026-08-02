import { alg, Graph } from "@dagrejs/graphlib";
import { compareUtf16CodeUnits } from "../determinism";
import type { DependencyModel, ExecutionPlansModel } from "./model";

type PlanDependency = Pick<DependencyModel, "mode" | "parameterIndex" | "targetId">;

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

function orderedDependencies(
  provider: PlanProvider,
  includeDelayed: boolean,
): readonly PlanDependency[] {
  return provider.dependencies
    .filter((edge) => includeDelayed || edge.mode === "eager")
    .toSorted((left, right) => {
      const target = compareUtf16CodeUnits(left.targetId, right.targetId);
      return target === 0 ? left.parameterIndex - right.parameterIndex : target;
    });
}

function markCycleProxyEdges(providers: readonly PlanProvider[]): void {
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  for (const component of stronglyConnectedComponents(providers, false)) {
    const members = new Set(component.members);
    const state = new Map<string, "active" | "complete">();

    function visitEdge(edge: PlanDependency): void {
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
      for (const edge of orderedDependencies(provider, false)) {
        visitEdge(edge);
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
): readonly string[] {
  const dependencies = new Map(
    providers.map((provider) => [
      provider.id,
      new Set(orderedDependencies(provider, includeDelayed).map((edge) => edge.targetId)),
    ]),
  );
  return globallyReadyOrder(
    providers.map((provider) => provider.id),
    dependencies,
  );
}

function globallyReadyOrder(
  keys: readonly string[],
  dependencies: ReadonlyMap<string, ReadonlySet<string>>,
): readonly string[] {
  const pending = keys.toSorted(compareUtf16CodeUnits);
  const emitted = new Set<string>();
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
    for (const edge of orderedDependencies(provider, includeDelayed)) {
      graph.setEdge(provider.id, edge.targetId);
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
    for (const edge of provider.dependencies) {
      const targetComponent = componentByMember.get(edge.targetId);
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

export function createExecutionPlans(providers: readonly PlanProvider[]): ExecutionPlansModel {
  markCycleProxyEdges(providers);
  const constructionOrder = dependencyFirstOrder(providers, false);
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
