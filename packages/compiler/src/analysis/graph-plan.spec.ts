import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { createExecutionPlans } from "#internal/analysis/graph-plan";
import type { DependencyModel } from "#internal/analysis/model";

type TestDependency = Pick<DependencyModel, "mode" | "parameterIndex" | "targetId">;

interface TestProvider {
  readonly kind: "class";
  readonly id: string;
  readonly dependencies: readonly TestDependency[];
  readonly startHook: boolean;
  readonly closeHook: boolean;
}

interface GraphEdge {
  readonly sourceId: string;
  readonly targetId: string;
  readonly mode: "eager" | "explicit-lazy";
}

interface GraphCase {
  readonly ids: readonly string[];
  readonly edges: readonly GraphEdge[];
}

const beanIdArbitrary = fc
  .tuple(fc.stringMatching(/^[a-z][a-z0-9]{0,5}$/), fc.nat(9_999))
  .map(([path, suffix]) => `src/${path}-${suffix}.ts#Bean${suffix}`);

const graphCaseArbitrary = fc
  .uniqueArray(beanIdArbitrary, { minLength: 1, maxLength: 6 })
  .chain((ids) =>
    fc
      .uniqueArray(
        fc.record({
          sourceIndex: fc.integer({ min: 0, max: ids.length - 1 }),
          targetIndex: fc.integer({ min: 0, max: ids.length - 1 }),
          mode: fc.constantFrom<GraphEdge["mode"]>("eager", "explicit-lazy"),
        }),
        {
          maxLength: ids.length * ids.length,
          selector: ({ sourceIndex, targetIndex }) => `${sourceIndex}:${targetIndex}`,
        },
      )
      .map((edges) => ({
        ids,
        edges: edges.map(({ sourceIndex, targetIndex, mode }) => ({
          sourceId: ids[sourceIndex] ?? "",
          targetId: ids[targetIndex] ?? "",
          mode,
        })),
      })),
  );

const shuffledGraphCaseArbitrary = graphCaseArbitrary.chain((graph) =>
  fc.tuple(
    fc.constant(graph),
    fc.shuffledSubarray(graph.ids, {
      minLength: graph.ids.length,
      maxLength: graph.ids.length,
    }),
    fc.shuffledSubarray(graph.edges, {
      minLength: graph.edges.length,
      maxLength: graph.edges.length,
    }),
  ),
);

function dependency(targetId: string): TestDependency {
  return {
    mode: "eager",
    parameterIndex: 0,
    targetId,
  };
}

function lifecycleProvider(id: string, dependencies: readonly TestDependency[]): TestProvider {
  return {
    kind: "class",
    id,
    dependencies,
    startHook: true,
    closeHook: true,
  };
}

function providersFor(
  graph: GraphCase,
  ids: readonly string[] = graph.ids,
  edges: readonly GraphEdge[] = graph.edges,
): TestProvider[] {
  return ids.map((id) =>
    lifecycleProvider(
      id,
      edges
        .filter((edge) => edge.sourceId === id)
        .map((edge, parameterIndex) => ({
          mode: edge.mode,
          parameterIndex,
          targetId: edge.targetId,
        })),
    ),
  );
}

function resultFor(providers: TestProvider[]): object {
  const plans = createExecutionPlans(providers);
  const dependencyModes = providers
    .flatMap((provider) =>
      provider.dependencies.map((edge) => ({
        sourceId: provider.id,
        targetId: edge.targetId,
        mode: edge.mode,
      })),
    )
    .toSorted((left, right) => {
      const source = left.sourceId < right.sourceId ? -1 : Number(left.sourceId > right.sourceId);
      if (source !== 0) {
        return source;
      }
      return left.targetId < right.targetId ? -1 : Number(left.targetId > right.targetId);
    });
  return { plans, dependencyModes };
}

function hasEagerCycle(providers: readonly TestProvider[]): boolean {
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const state = new Map<string, "active" | "complete">();

  function visit(id: string): boolean {
    if (state.get(id) === "active") {
      return true;
    }
    if (state.get(id) === "complete") {
      return false;
    }
    state.set(id, "active");
    const provider = providerById.get(id);
    for (const edge of provider?.dependencies ?? []) {
      if (edge.mode === "eager" && visit(edge.targetId)) {
        return true;
      }
    }
    state.set(id, "complete");
    return false;
  }

  return providers.some((provider) => visit(provider.id));
}

function isReachable(
  graph: GraphCase,
  sourceId: string,
  targetId: string,
  visited = new Set<string>(),
): boolean {
  if (sourceId === targetId) {
    return true;
  }
  if (visited.has(sourceId)) {
    return false;
  }
  visited.add(sourceId);
  return graph.edges
    .filter((edge) => edge.mode === "eager" && edge.sourceId === sourceId)
    .some((edge) => isReachable(graph, edge.targetId, targetId, visited));
}

describe("execution plans", () => {
  test("selects the smallest globally ready provider at each step", () => {
    const providers = [
      lifecycleProvider("a", [dependency("z")]),
      lifecycleProvider("b", []),
      lifecycleProvider("z", []),
    ];

    const plans = createExecutionPlans(providers);

    expect(plans).toEqual({
      constructionOrder: ["b", "z", "a"],
      startActionOrder: ["b", "z", "a"],
      cleanupActionOrder: ["a", "z", "b"],
    });
  });

  test("starts cycle traversal at the smallest member of each component", () => {
    const dependencyFromB = dependency("z");
    const dependencyFromZ = dependency("b");
    const providers = [
      lifecycleProvider("a", [dependency("z")]),
      lifecycleProvider("b", [dependencyFromB]),
      lifecycleProvider("z", [dependencyFromZ]),
    ];

    const plans = createExecutionPlans(providers);

    expect(dependencyFromB.mode).toBe("eager");
    expect(dependencyFromZ.mode).toBe("cycle-proxy");
    expect(plans).toEqual({
      constructionOrder: ["z", "a", "b"],
      startActionOrder: ["b", "z", "a"],
      cleanupActionOrder: ["a", "z", "b"],
    });
  });

  test("produces the same plans and proxy edges after shuffled inputs", () => {
    fc.assert(
      fc.property(shuffledGraphCaseArbitrary, ([graph, shuffledIds, shuffledEdges]) => {
        const baseline = resultFor(providersFor(graph));
        const shuffled = resultFor(providersFor(graph, shuffledIds, shuffledEdges));

        expect(shuffled).toEqual(baseline);
      }),
    );
  });

  test("leaves the eager dependency graph acyclic", () => {
    fc.assert(
      fc.property(graphCaseArbitrary, (graph) => {
        const providers = providersFor(graph);

        createExecutionPlans(providers);

        expect(hasEagerCycle(providers)).toBeFalse();
      }),
    );
  });

  test("marks only dependencies within the same original eager component as cycle proxies", () => {
    fc.assert(
      fc.property(graphCaseArbitrary, (graph) => {
        const providers = providersFor(graph);

        createExecutionPlans(providers);

        for (const provider of providers) {
          for (const dependency of provider.dependencies) {
            if (dependency.mode === "cycle-proxy") {
              expect(isReachable(graph, provider.id, dependency.targetId)).toBeTrue();
              expect(isReachable(graph, dependency.targetId, provider.id)).toBeTrue();
            }
          }
        }
      }),
    );
  });

  test("does not use explicit lazy dependencies to classify eager cycles", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(beanIdArbitrary, { minLength: 2, maxLength: 2 }),
        fc.boolean(),
        (ids, reverse) => {
          const [first = "", second = ""] = ids;
          const graph: GraphCase = {
            ids: reverse ? [second, first] : [first, second],
            edges: [
              { sourceId: first, targetId: second, mode: "eager" },
              { sourceId: second, targetId: first, mode: "explicit-lazy" },
            ],
          };
          const providers = providersFor(graph);

          createExecutionPlans(providers);

          expect(
            providers.flatMap((provider) => provider.dependencies.map((edge) => edge.mode)),
          ).toEqual(expect.arrayContaining(["eager", "explicit-lazy"]));
          expect(
            providers.some((provider) =>
              provider.dependencies.some((edge) => edge.mode === "cycle-proxy"),
            ),
          ).toBeFalse();
        },
      ),
    );
  });
});
