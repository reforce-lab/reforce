import fc from "fast-check";
import { describe, expect, test } from "vitest";
import type { ProviderDraft } from "@/analysis/model";
import {
  type AnalysisPass,
  channelOrderProblems,
  type PassContext,
  type PassRegistry,
  runContributePasses,
  runDiscoverPasses,
} from "@/analysis/pass";
import {
  createPassChannels,
  orderInsensitiveChannels,
  type PassChannels,
} from "@/analysis/pass-channels";
import { analysisPasses } from "@/analysis/pass-registry";
import type { CompilerDiagnostic } from "@/api";
import type { ProjectLinker } from "@/linking/project-linker";
import { emptyStarterLinkage } from "@/linking/starter-linking";
import { singleFileIr } from "./support/ir";

// pass 架构的确定性纪律（#344 定案 4）。注册表把「顺序理由」从注释变成了可执行检查，这三条
// 断言就是那份检查——它们守的是「两次编译逐字节相同」这条不变量，不是某个具体 pass 的行为。

const file = singleFileIr("src/application.ts", "/project/src/application.ts");

// 断言 A/B/C 只看注册表形状与驱动的遍历顺序，注册的 pass 一次也不会碰 linker。要 linker 参与
// 的行为断言属于 it/，不属于本文件。
const inertLinker: ProjectLinker = {
  diagnostics: [],
  starterLinkage: emptyStarterLinkage,
  collectWatchInputs: () => ({
    fileDependencies: [],
    contextDependencies: [],
    missingDependencies: [],
  }),
  resolveEntity: () => undefined,
  resolveType: () => undefined,
  resolveValueDeclaration: () => undefined,
  symbolForDeclaration: () => undefined,
};

function passContext(diagnostics: CompilerDiagnostic[] = []): PassContext {
  return { sources: [], linker: inertLinker, diagnostics, typeQuery: undefined };
}

function draftOf(id: string): ProviderDraft {
  return {
    provider: {
      kind: "class",
      id,
      origin: { kind: "application", source: file.source },
      exportName: id,
      declarationSource: {
        file: "src/application.ts",
        start: { offset: 0, line: 0, character: 0 },
        end: { offset: 1, line: 0, character: 1 },
      },
      provides: [],
      scope: "singleton",
      primary: false,
      fallback: false,
      qualifiers: [],
      dependencies: [],
      startHook: false,
      closeHook: false,
    },
    pendingDependencies: [],
  };
}

function producer(name: string, phase: "contribute" | "discover", ids: readonly string[]) {
  const pass: AnalysisPass =
    phase === "discover"
      ? { name, phase, reads: [], writes: [], run: () => ids.map(draftOf) }
      : { name, phase, reads: [], writes: [], run: () => ids.map(draftOf) };
  return pass;
}

describe("断言 A · 注册表序与通道拓扑一致", () => {
  test("每条通道的 reader 都排在它的最后一个 writer 之后", () => {
    const problems = channelOrderProblems(analysisPasses);

    expect(problems).toEqual([]);
  });

  test("读在写之前会被点名，而不是靠人读注释发现", () => {
    const reader: AnalysisPass = {
      name: "reader",
      phase: "discover",
      reads: ["engineBeans"],
      writes: [],
      run: () => [],
    };
    const writer: AnalysisPass = {
      name: "writer",
      phase: "discover",
      reads: [],
      writes: ["engineBeans"],
      run: () => [],
    };

    const problems = channelOrderProblems([reader, writer]);

    expect(problems).toEqual([
      "reader reads engineBeans at index 0 but writer writes it at index 1",
    ]);
  });
});

describe("断言 B · 通道的消费方自己定序", () => {
  test("注册表里每条多写通道都登记为消费前排序", () => {
    // 一条通道有两个以上写者，注册表下标序就成了它的写入序；下游按写入序消费的话，那个顺序
    // 就变成事实上的契约。登记的意思是「读者自己排序」，这条断言保证没人漏登记。
    const writerCount = new Map<keyof PassChannels, number>();
    for (const pass of analysisPasses) {
      for (const channel of pass.writes) {
        writerCount.set(channel, (writerCount.get(channel) ?? 0) + 1);
      }
    }
    const unregistered = [...writerCount.entries()]
      .filter(([channel, count]) => count > 1 && !orderInsensitiveChannels.has(channel))
      .map(([channel]) => channel);

    expect(unregistered).toEqual([]);
  });

  test("闭集里的每条通道都有写者：没人写的通道是死重，读者在等一个永不到达的值", () => {
    // 通道是闭集（pass-channels.ts），所以「有没有多余的一条」是可以机械判定的。读者可以是
    // 核心步而不是 pass（claimedDeclarations 的读者是 collectProviderDrafts），所以只核写者。
    const written = new Set<string>(analysisPasses.flatMap((pass) => pass.writes));
    const orphans = Object.keys(createPassChannels()).filter((channel) => !written.has(channel));

    expect(orphans).toEqual([]);
  });

  test("frameworkLoggers 恒在登记表里：它按设计就是多写单读的那条", () => {
    expect(orderInsensitiveChannels.has("frameworkLoggers")).toBe(true);
  });

  test("只 has / get 的两条通道不把写入序暴露给下游", () => {
    const channels = createPassChannels();

    channels.demandedBeanIds.add("b");
    channels.demandedBeanIds.add("a");
    channels.resolutionOverrides.redirects.set("b", "x");

    expect(channels.demandedBeanIds.has("a")).toBe(true);
    expect(channels.resolutionOverrides.redirects.get("b")).toBe("x");
  });
});

describe("断言 C · 同相位内无通道关系的 pass 顺序不可观测", () => {
  test("打乱互不相干的 discover pass，产出的 draft 集合不随顺序变化", () => {
    const names = ["alpha", "beta", "gamma"];

    fc.assert(
      fc.property(fc.shuffledSubarray(names, { minLength: 3 }), (order) => {
        const registry: PassRegistry = order.map((name) => producer(name, "discover", [name]));

        const drafts = runDiscoverPasses(registry, passContext(), createPassChannels());

        return (
          drafts
            .map((draft) => draft.provider.id)
            .toSorted()
            .join(",") === [...names].toSorted().join(",")
        );
      }),
    );
  });
});

describe("contribute 驱动", () => {
  test("后一个 pass 看得见前一个贡献的 draft", () => {
    const seen: number[] = [];
    const observing = (name: string, ids: readonly string[]): AnalysisPass => ({
      name,
      phase: "contribute",
      reads: [],
      writes: [],
      run: (_context, drafts) => {
        seen.push(drafts.length);
        return ids.map(draftOf);
      },
    });

    runContributePasses(
      [observing("first", ["a", "b"]), observing("second", [])],
      passContext(),
      [],
      createPassChannels(),
    );

    expect(seen).toEqual([0, 2]);
  });
});
