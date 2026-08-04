import { describe, expect, test } from "bun:test";
import { type ContractExplanation, explainContracts } from "@/explain/selection";
import type { InstalledStarter } from "@/explain/starter-metas";
import type { GeneratedManifest, ManifestBean } from "@/project/generated-manifest";

// 选择链再推导的规则面（ADR 0004 决策 12，#148）：本地恒胜、defaultBean 让位、primary 决胜。
// 输入是手工构造的 manifest/meta 数据——这里测的是纯推导规则，不测 manifest 解析与磁盘发现。

const span = {
  file: "src/a.ts",
  start: { offset: 0, line: 0, character: 0 },
  end: { offset: 1, line: 0, character: 1 },
};

function bean(
  overrides: Partial<ManifestBean> & Pick<ManifestBean, "id" | "origin">,
): ManifestBean {
  return {
    kind: "class",
    source: span,
    runtimeExport: { moduleSpecifier: "../../src/a.js", exportName: "A" },
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
    schemaVersion: 3,
    configs: [],
    beans,
    plans: {
      constructionOrder: beans.map((entry) => entry.id),
      startActionOrder: [],
      cleanupActionOrder: [],
    },
  };
}

function starter(
  beans: readonly {
    readonly id: string;
    readonly provides: readonly string[];
    readonly defaultBean: boolean;
  }[],
  overrides: Partial<InstalledStarter> = {},
): InstalledStarter {
  return {
    packageName: "@acme/starter-redis",
    version: "1.2.0",
    location: "node_modules/@acme/starter-redis",
    realRootPath: "/real/starter-redis",
    introducedBy: undefined,
    beans,
    ...overrides,
  };
}

const redisClientMetaBean = {
  id: "@acme/starter-redis#RedisClient",
  provides: ["@acme/starter-redis#RedisClient", "@acme/starter-redis#Cache"],
  defaultBean: true,
};

function firstExplanation(...args: Parameters<typeof explainContracts>): ContractExplanation {
  const [explanation] = explainContracts(...args);
  if (explanation === undefined) {
    throw new Error("Expected the target bean to provide at least one contract");
  }
  return explanation;
}

describe("explainContracts", () => {
  test("a local provider forces starter candidates aside", () => {
    const local = bean({
      id: "src/a.ts#LocalCache",
      origin: "application",
      provides: [cacheSymbol],
    });
    const manifest = manifestOf([local]);

    const explanation = firstExplanation(manifest, [starter([redisClientMetaBean])], local);

    expect(explanation.injectionWinner?.id).toBe("src/a.ts#LocalCache");
    expect(explanation.standingAside).toEqual([
      {
        beanId: "@acme/starter-redis#RedisClient",
        origin: "@acme/starter-redis@1.2.0",
        reason: "local-provider-wins",
      },
    ]);
  });

  test("a default bean stands aside when another starter provider won", () => {
    const winner = bean({
      id: "@acme/starter-valkey#ValkeyClient",
      origin: "@acme/starter-valkey@2.0.0",
      runtimeExport: { moduleSpecifier: "@acme/starter-valkey", exportName: "ValkeyClient" },
      provides: [cacheSymbol],
    });
    const manifest = manifestOf([winner]);

    const explanation = firstExplanation(manifest, [starter([redisClientMetaBean])], winner);

    expect(explanation.standingAside.map((entry) => entry.reason)).toEqual([
      "default-bean-stands-aside",
    ]);
  });

  test("a non-default unmaterialized starter bean renders as not selected", () => {
    const winner = bean({
      id: "@acme/starter-valkey#ValkeyClient",
      origin: "@acme/starter-valkey@2.0.0",
      runtimeExport: { moduleSpecifier: "@acme/starter-valkey", exportName: "ValkeyClient" },
      provides: [cacheSymbol],
    });
    const manifest = manifestOf([winner]);
    const candidates = [starter([{ ...redisClientMetaBean, defaultBean: false }])];

    const explanation = firstExplanation(manifest, candidates, winner);

    expect(explanation.standingAside.map((entry) => entry.reason)).toEqual(["not-selected"]);
  });

  test("a materialized starter bean is not listed as standing aside", () => {
    const materialized = bean({
      id: "@acme/starter-redis#RedisClient",
      origin: "@acme/starter-redis@1.2.0",
      runtimeExport: { moduleSpecifier: "@acme/starter-redis", exportName: "RedisClient" },
      provides: [cacheSymbol],
    });
    const manifest = manifestOf([materialized]);

    const explanation = firstExplanation(manifest, [starter([redisClientMetaBean])], materialized);

    expect(explanation.standingAside).toEqual([]);
    expect(explanation.injectionWinner?.id).toBe("@acme/starter-redis#RedisClient");
  });

  test("the unique primary wins among several manifest providers", () => {
    const primary = bean({
      id: "src/a.ts#PrimaryCache",
      origin: "application",
      primary: true,
      provides: [cacheSymbol],
    });
    const secondary = bean({
      id: "src/b.ts#OtherCache",
      origin: "application",
      provides: [cacheSymbol],
    });
    const manifest = manifestOf([primary, secondary]);

    const explanation = firstExplanation(manifest, [], primary);

    expect(explanation.providers.map((provider) => provider.id)).toEqual([
      "src/a.ts#PrimaryCache",
      "src/b.ts#OtherCache",
    ]);
    expect(explanation.injectionWinner?.id).toBe("src/a.ts#PrimaryCache");
  });

  test("several providers without a unique primary leave no injection winner", () => {
    const first = bean({
      id: "src/a.ts#FirstCache",
      origin: "application",
      provides: [cacheSymbol],
    });
    const second = bean({
      id: "src/b.ts#SecondCache",
      origin: "application",
      provides: [cacheSymbol],
    });
    const manifest = manifestOf([first, second]);

    const explanation = firstExplanation(manifest, [], first);

    expect(explanation.injectionWinner).toBeUndefined();
  });

  test("file-coordinate contracts match by package name and export name", () => {
    const contractSymbol = {
      displayName: "Config",
      moduleSpecifier: "@acme/contracts",
      exportName: "Config",
    };
    const local = bean({
      id: "src/a.ts#LocalConfig",
      origin: "application",
      provides: [contractSymbol],
    });
    const manifest = manifestOf([local]);
    const candidates = [
      starter([
        {
          id: "@acme/starter-redis#FileConfig",
          provides: ["@acme/contracts:./dist/config.d.ts#Config"],
          defaultBean: false,
        },
      ]),
    ];

    const explanation = firstExplanation(manifest, candidates, local);

    expect(explanation.standingAside.map((entry) => entry.beanId)).toEqual([
      "@acme/starter-redis#FileConfig",
    ]);
  });
});
