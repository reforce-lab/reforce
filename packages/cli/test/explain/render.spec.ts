import { describe, expect, test } from "vitest";
import { renderExplanation } from "@/explain/render";
import { explainContracts } from "@/explain/selection";
import type { InstalledStarter } from "@/explain/starter-metas";
import type { WeavingMethod } from "@/explain/weaving";
import type { GeneratedManifest, ManifestBean } from "@/project/generated-manifest";

// explain 的呈现契约（#148 / M1 遗留账，PR #154）：origin 的用户可读形态、让位与胜出理由的
// 文案、决策 10 多版本拷贝的引入链。断言精确到行——输出行是命令的对外契约。

const span = {
  file: "src/client.ts",
  start: { offset: 0, line: 0, character: 0 },
  end: { offset: 1, line: 0, character: 1 },
};

function bean(
  overrides: Partial<ManifestBean> & Pick<ManifestBean, "id" | "origin">,
): ManifestBean {
  return {
    kind: "class",
    scope: "singleton",
    source: span,
    runtimeExport: { moduleSpecifier: "../../src/client.js", exportName: "A" },
    provides: [],
    dependencies: [],
    primary: false,
    qualifiers: [],
    lifecycle: { start: false, close: false, dispose: false },
    ...overrides,
  };
}

const cacheSymbol = {
  displayName: "Cache",
  moduleSpecifier: "@acme/starter-redis",
  exportName: "Cache",
};

function manifestOf(beans: readonly ManifestBean[]): GeneratedManifest {
  return {
    schemaVersion: 6,
    configs: [],
    beans,
    plans: {
      constructionOrder: beans.map((entry) => entry.id),
      requestConstructionOrder: [],
      startActionOrder: [],
      cleanupActionOrder: [],
    },
  };
}

function render(
  manifest: GeneratedManifest,
  target: ManifestBean,
  starters: readonly InstalledStarter[] = [],
  wovenMethods: readonly WeavingMethod[] = [],
): readonly string[] {
  return renderExplanation({
    manifest,
    bean: target,
    starters,
    contracts: explainContracts(manifest, starters, target),
    wovenMethods,
  });
}

describe("renderExplanation", () => {
  test("renders an application origin as this application with a 1-based location", () => {
    const local = bean({ id: "src/client.ts#LocalCache", origin: "application" });

    const lines = render(manifestOf([local]), local);

    expect(lines).toContain("origin this application · declared at src/client.ts:1:1");
  });

  test("renders a starter origin with its package-relative declaration", () => {
    const starterBean = bean({
      id: "@acme/starter-redis#RedisClient",
      origin: "@acme/starter-redis@1.2.0",
      runtimeExport: { moduleSpecifier: "@acme/starter-redis", exportName: "RedisClient" },
    });

    const lines = render(manifestOf([starterBean]), starterBean);

    expect(lines).toContain(
      "origin @acme/starter-redis@1.2.0 · registered starter · declared at src/client.ts:1:1 (package-relative)",
    );
  });

  test("renders an accepted default provider reason", () => {
    const starterBean = bean({
      id: "@acme/starter-redis#RedisClient",
      origin: "@acme/starter-redis@1.2.0",
      runtimeExport: { moduleSpecifier: "@acme/starter-redis", exportName: "RedisClient" },
      provides: [cacheSymbol],
    });
    const starters: readonly InstalledStarter[] = [
      {
        packageName: "@acme/starter-redis",
        version: "1.2.0",
        location: "node_modules/@acme/starter-redis",
        realRootPath: "/real/starter-redis",
        introducedBy: undefined,
        beans: [
          {
            id: "@acme/starter-redis#RedisClient",
            provides: ["@acme/starter-redis#Cache"],
            defaultBean: true,
          },
        ],
      },
    ];

    const lines = render(manifestOf([starterBean]), starterBean, starters);

    expect(lines).toContain(
      "  selected @acme/starter-redis#RedisClient (@acme/starter-redis@1.2.0 · registered starter) — accepted default provider — no local or competing provider",
    );
  });

  test("renders a dependency edge with the target bean origin and mode", () => {
    const target = bean({
      id: "@acme/starter-redis#RedisClient",
      origin: "@acme/starter-redis@1.2.0",
      runtimeExport: { moduleSpecifier: "@acme/starter-redis", exportName: "RedisClient" },
    });
    const consumer = bean({
      id: "src/client.ts#CacheConsumer",
      origin: "application",
      dependencies: [
        {
          parameterIndex: 0,
          targetId: "@acme/starter-redis#RedisClient",
          mode: "eager",
          source: span,
        },
      ],
    });

    const lines = render(manifestOf([consumer, target]), consumer);

    expect(lines).toContain(
      "dependency [0] -> @acme/starter-redis#RedisClient · @acme/starter-redis@1.2.0 · registered starter · eager",
    );
  });

  test("renders a collection edge with one member line per injection position", () => {
    const alpha = bean({ id: "src/alpha.ts#Alpha", origin: "application" });
    const beta = bean({ id: "src/beta.ts#Beta", origin: "application" });
    const registry = bean({
      id: "src/registry.ts#Registry",
      origin: "application",
      dependencies: [
        {
          parameterIndex: 0,
          mode: "collection",
          members: [
            { targetId: "src/beta.ts#Beta", mode: "eager" },
            { targetId: "src/alpha.ts#Alpha", mode: "cycle-proxy" },
          ],
          source: span,
        },
      ],
    });

    const lines = render(manifestOf([alpha, beta, registry]), registry);

    const collectionIndex = lines.indexOf("dependency [0] -> collection · 2 member(s)");
    expect(collectionIndex).toBeGreaterThan(-1);
    expect(lines[collectionIndex + 1]).toBe("  member src/beta.ts#Beta · this application · eager");
    expect(lines[collectionIndex + 2]).toBe(
      "  member src/alpha.ts#Alpha · this application · cycle-proxy",
    );
  });

  test("renders the construction position within the plan order", () => {
    const first = bean({ id: "src/a.ts#First", origin: "application" });
    const second = bean({ id: "src/b.ts#Second", origin: "application" });

    const lines = render(manifestOf([first, second]), second);

    expect(lines).toContain("construction position 2 of 2");
  });

  test("renders introduction chains for multiple installed copies of a relevant package", () => {
    const starterBean = bean({
      id: "@acme/starter-redis#RedisClient",
      origin: "@acme/starter-redis@1.2.0",
      runtimeExport: { moduleSpecifier: "@acme/starter-redis", exportName: "RedisClient" },
      provides: [cacheSymbol],
    });
    const copies: readonly InstalledStarter[] = [
      {
        packageName: "@acme/starter-redis",
        version: "1.2.0",
        location: "node_modules/@acme/starter-redis",
        realRootPath: "/real/copy-one",
        introducedBy: undefined,
        beans: [],
      },
      {
        packageName: "@acme/starter-redis",
        version: "2.0.0",
        location: "node_modules/@acme/starter-a/node_modules/@acme/starter-redis",
        realRootPath: "/real/copy-two",
        introducedBy: "@acme/starter-a@1.0.0",
        beans: [],
      },
    ];

    const lines = render(manifestOf([starterBean]), starterBean, copies);

    expect(lines).toContain("copies @acme/starter-redis — 2 physical copies installed");
    expect(lines).toContain(
      "  1.2.0 at node_modules/@acme/starter-redis · reachable from the application root",
    );
    expect(lines).toContain(
      "  2.0.0 at node_modules/@acme/starter-a/node_modules/@acme/starter-redis · introduced by @acme/starter-a@1.0.0",
    );
  });
});

// 织入面（ADR 0008 AM2，#204 定案 7）：链序即行序、@Transactional 渲染缺省补齐后的生效
// 语义、空链方法照渲染；框架 bean 的 origin 与 declared-at 措辞独立于 starter。
describe("renderExplanation weaving", () => {
  const interceptorBean = bean({
    id: "@reforce/transaction#TransactionInterceptor",
    origin: "@reforce/transaction",
    runtimeExport: {
      moduleSpecifier: "@reforce/transaction/generated-runtime",
      exportName: "TransactionInterceptor",
    },
  });
  const transactionEntry = {
    beanId: "@reforce/transaction#TransactionInterceptor",
    phase: "transaction",
    order: 0,
    marker: "transactional",
  };

  test("renders the framework interceptor origin with its first-use declaration", () => {
    const lines = render(manifestOf([interceptorBean]), interceptorBean);

    expect(lines).toContain(
      "origin @reforce/transaction · framework · declared at src/client.ts:1:1 (first @Transactional use)",
    );
  });

  test("renders effective transactional semantics with defaults applied", () => {
    const target = bean({ id: "src/service.ts#OrderService", origin: "application" });

    const lines = render(
      manifestOf([target, interceptorBean]),
      target,
      [],
      [{ method: "save", markers: { transactional: null }, chain: [transactionEntry] }],
    );

    expect(lines).toContain("woven method save");
    expect(lines).toContain(
      "  marker transactional · effective propagation REQUIRED · effective isolation database default",
    );
    expect(lines).toContain(
      "  chain [1] @reforce/transaction#TransactionInterceptor · @reforce/transaction · framework · phase transaction · order 0 · via transactional",
    );
  });

  test("renders declared transactional literals over the defaults", () => {
    const target = bean({ id: "src/service.ts#OrderService", origin: "application" });

    const lines = render(
      manifestOf([target, interceptorBean]),
      target,
      [],
      [
        {
          method: "audit",
          markers: { transactional: { propagation: "REQUIRES_NEW", isolation: "SERIALIZABLE" } },
          chain: [transactionEntry],
        },
      ],
    );

    expect(lines).toContain(
      "  marker transactional · effective propagation REQUIRES_NEW · effective isolation SERIALIZABLE",
    );
  });

  test("renders a marked method with an empty chain as unbound", () => {
    const target = bean({ id: "src/service.ts#OrderService", origin: "application" });

    const lines = render(
      manifestOf([target]),
      target,
      [],
      [{ method: "save", markers: { audited: { label: "x" } }, chain: [] }],
    );

    expect(lines).toContain('  marker audited · value {"label":"x"}');
    expect(lines).toContain("  chain empty · marked but no interceptor bound");
  });
});
