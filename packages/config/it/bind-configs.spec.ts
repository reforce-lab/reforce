import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { BeanClass } from "@reforce/context";
import type {
  GeneratedConfigRegistration,
  GeneratedSourceReference,
} from "@reforce/context/generated-runtime";
import { replayBootstrapLogs } from "@reforce/logging";
import { resetBootstrapRegistryForTest } from "@reforce/logging/testing";
import {
  createTemporaryProject,
  resolveNodeExecutable,
  runCommand,
  type TemporaryProject,
} from "@reforce/tooling-testing";
import { afterEach, describe, expect, test } from "vitest";
import { createConfigBinding } from "@/binding/bind-configs";
import { ConfigProperties } from "@/config-properties";
import { failingField, numberField, objectSchema, stringField } from "./support/standard-schema";

const projects: TemporaryProject[] = [];

afterEach(async () => {
  await Promise.all(projects.splice(0).map((project) => project.cleanup()));
});

async function projectWith(tree: Record<string, string>): Promise<string> {
  const project = await createTemporaryProject(tree);
  projects.push(project);
  return project.projectRoot;
}

function testSource(file: string): GeneratedSourceReference {
  const position = { offset: 0, line: 1, character: 0 };
  return { file, start: position, end: position };
}

function registrationOf(id: string, target: BeanClass): GeneratedConfigRegistration {
  return { kind: "config", id, source: testSource(`${id}.ts`), target };
}

async function withProcessEnv(
  overrides: Readonly<Record<string, string>>,
  run: () => Promise<void>,
): Promise<void> {
  const saved = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  try {
    await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("createConfigBinding", () => {
  test("binds multiple configs from .env and process env layers", async () => {
    const root = await projectWith({
      ".env": "DEMO_SERVER_PORT=8080\nDEMO_METRICS_ENDPOINT=http://metrics.internal\n",
    });
    const serverSchema = objectSchema<{ port: number; host: string }>({
      port: numberField(),
      host: stringField(),
    });
    // async 变体覆盖 validate 返回 Promise 的路径
    const metricsSchema = objectSchema<{ endpoint: string }>(
      { endpoint: stringField() },
      { async: true },
    );
    class ServerConfig extends ConfigProperties("demo.server", serverSchema) {}
    class MetricsConfig extends ConfigProperties("demo.metrics", metricsSchema) {}

    await withProcessEnv({ DEMO_SERVER_HOST: "from-process" }, async () => {
      const outcome = await createConfigBinding({ root }).bind([
        registrationOf("demo-server", ServerConfig),
        registrationOf("demo-metrics", MetricsConfig),
      ]);

      expect(outcome.status).toBe("bound");
      if (outcome.status !== "bound") {
        return;
      }
      const server = outcome.instances.get("demo-server");
      const metrics = outcome.instances.get("demo-metrics");
      if (!(server instanceof ServerConfig) || !(metrics instanceof MetricsConfig)) {
        throw new Error("bound instances must be constructed from the registered classes");
      }
      expect(server.port).toBe(8080);
      expect(server.host).toBe("from-process");
      expect(metrics.endpoint).toBe("http://metrics.internal");
    });
  });

  test("passes raw environment strings to the schema", async () => {
    const root = await projectWith({ ".env": "DEMO_SERVER_PORT=8080\n" });
    const inputs: unknown[] = [];
    const schema = objectSchema<{ port: number }>(
      { port: numberField() },
      { onValidate: (input) => inputs.push(input) },
    );
    class ServerConfig extends ConfigProperties("demo.server", schema) {}

    await createConfigBinding({ root }).bind([registrationOf("demo-server", ServerConfig)]);

    // 类型转换是 schema 的职责：框架只把环境变量的字符串原样交给 validate
    expect(inputs).toEqual([{ port: "8080" }]);
  });

  test("aggregates issues across all failing configs without leaking values", async () => {
    const root = await projectWith({ ".env": "AGG_ONE_ALPHA=secret-value\n" });
    const oneSchema = objectSchema<{ alpha: never; beta: never }>({
      alpha: failingField("alpha is invalid"),
      beta: failingField("beta is invalid"),
    });
    const twoSchema = objectSchema<{ gamma: never; delta: never }>({
      gamma: failingField("gamma is invalid"),
      delta: failingField("delta is invalid"),
    });
    class OneConfig extends ConfigProperties("agg.one", oneSchema) {}
    class TwoConfig extends ConfigProperties("agg.two", twoSchema) {}

    const outcome = await createConfigBinding({ root }).bind([
      registrationOf("agg-one", OneConfig),
      registrationOf("agg-two", TwoConfig),
    ]);

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") {
      return;
    }
    expect(outcome.issues).toHaveLength(4);
    const alphaIssue = outcome.issues.find(
      (issue) => issue.configId === "agg-one" && issue.environmentVariable === "AGG_ONE_ALPHA",
    );
    expect(alphaIssue?.keyPath).toEqual(["alpha"]);
    expect(alphaIssue?.layer).toBe(".env");
    expect(alphaIssue?.reason).toBe("alpha is invalid");
    const betaIssue = outcome.issues.find(
      (issue) => issue.configId === "agg-one" && issue.environmentVariable === "AGG_ONE_BETA",
    );
    expect(betaIssue?.layer).toBe("unset");
    expect(outcome.issues.filter((issue) => issue.configId === "agg-two")).toHaveLength(2);
    // 诊断数据永不携带配置值（ADR 0005 决策 6.2）
    expect(JSON.stringify(outcome.issues)).not.toContain("secret-value");
  });

  test("throws a TypeError when a registration target carries no metadata", async () => {
    const root = await projectWith({});
    class PlainClass {}

    const binding = createConfigBinding({ root });

    await expect(binding.bind([registrationOf("plain", PlainClass)])).rejects.toThrow(TypeError);
    await expect(binding.bind([registrationOf("plain", PlainClass)])).rejects.toThrow("plain");
  });

  test("warns about unmatched keys under the prefix with a near-name suggestion", async () => {
    const root = await projectWith({
      ".env": "TYPO_HTTP_PORT=8080\nTYPO_HTTP_PROT=9999\n",
    });
    const schema = objectSchema<{ httpPort: number }>({ httpPort: numberField() });
    class TypoConfig extends ConfigProperties("typo", schema) {}

    // 绑定 phase 跑在一切 bean 构造之前，警告只能先进引导缓冲；这条用例顺带把整条链路
    // 走了一遍：写进缓冲 → 重放进真绑定（RFC 0011 L7/L8，#249/#250）。
    resetBootstrapRegistryForTest();
    const outcome = await createConfigBinding({ root }).bind([
      registrationOf("typo-config", TypoConfig),
    ]);
    const replayed: { readonly fields: Record<string, unknown>; readonly message: string }[] = [];
    replayBootstrapLogs({
      create: () => ({
        isEnabled: () => true,
        trace: () => {},
        debug: () => {},
        info: () => {},
        warn: (fields, message) => replayed.push({ fields: { ...fields }, message }),
        error: () => {},
        fatal: () => {},
      }),
    });

    expect(outcome.status).toBe("bound");
    const unmatched = replayed.filter((entry) => entry.fields.key === "TYPO_HTTP_PROT");
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0]?.fields).toMatchObject({
      configId: "typo-config",
      suggestion: "TYPO_HTTP_PORT",
    });
    expect(replayed.some((entry) => entry.fields.key === "TYPO_HTTP_PORT")).toBe(false);
  });

  test("reads env files from the root option instead of the working directory", async () => {
    const root = await projectWith({ ".env": "ROOTED_APP_VALUE=from-root-file\n" });
    const schema = objectSchema<{ value: string }>({ value: stringField() });
    class RootedConfig extends ConfigProperties("rooted.app", schema) {}

    // 测试进程 cwd 是仓库目录，.env 只存在于临时 root 下
    const outcome = await createConfigBinding({ root }).bind([
      registrationOf("rooted", RootedConfig),
    ]);

    expect(outcome.status).toBe("bound");
    if (outcome.status !== "bound") {
      return;
    }
    const instance = outcome.instances.get("rooted");
    if (!(instance instanceof RootedConfig)) {
      throw new Error("bound instance must be a RootedConfig");
    }
    expect(instance.value).toBe("from-root-file");
  });

  // dist 的新鲜度由 turbo 保证（本包 turbo.json 让 test 依赖自身 build），不在测试内重建：
  // rslib 构建会先清空 dist 再产出，清空窗口内并发的 compiler IT 经 junction 消费同一份
  // dist，会撞出 TS2307 假失败（Issue #169）。代价是在包目录裸跑 vitest 前需先有 dist。
  test("produces the same bound values in a child process consuming the built dist", async () => {
    const packageRoot = resolve(import.meta.dirname, "..");
    const nodeExecutable = await resolveNodeExecutable();
    const indexUrl = pathToFileURL(resolve(packageRoot, "dist/index.js")).href;
    const runtimeUrl = pathToFileURL(resolve(packageRoot, "dist/generated-runtime.js")).href;
    const script = [
      `import { ConfigProperties } from ${JSON.stringify(indexUrl)};`,
      `import { createConfigBinding } from ${JSON.stringify(runtimeUrl)};`,
      "const schema = {",
      '  "~standard": {',
      "    version: 1,",
      '    vendor: "neutrality-it",',
      "    validate: (input) => ({",
      "      value: { port: Number(input.port), name: String(input.name) },",
      "    }),",
      "  },",
      "};",
      'class NeutralConfig extends ConfigProperties("neutral.app", schema) {}',
      "const position = { offset: 0, line: 1, character: 0 };",
      "const registration = {",
      '  kind: "config",',
      '  id: "neutral",',
      '  source: { file: "main.mjs", start: position, end: position },',
      "  target: NeutralConfig,",
      "};",
      "const outcome = await createConfigBinding({ root: process.cwd() }).bind([registration]);",
      'if (outcome.status !== "bound") {',
      "  console.error(JSON.stringify(outcome.issues));",
      "  process.exit(1);",
      "}",
      'console.log(JSON.stringify(outcome.instances.get("neutral")));',
    ].join("\n");
    const envFile = "NEUTRAL_APP_PORT=4321\nNEUTRAL_APP_NAME=neutral-service\n";
    const root = await projectWith({ ".env": envFile, "main.mjs": script });

    const nodeRun = await runCommand(nodeExecutable, ["main.mjs"], { cwd: root });
    const schema = objectSchema<{ port: number; name: string }>({
      port: numberField(),
      name: stringField(),
    });
    class NeutralConfig extends ConfigProperties("neutral.app", schema) {}
    const outcome = await createConfigBinding({ root }).bind([
      registrationOf("neutral", NeutralConfig),
    ]);

    expect(nodeRun.exitCode).toBe(0);
    expect(outcome.status).toBe("bound");
    if (outcome.status !== "bound") {
      return;
    }
    const inProcessInstance = outcome.instances.get("neutral");
    if (!(inProcessInstance instanceof NeutralConfig)) {
      throw new Error("bound instance must be a NeutralConfig");
    }
    const childInstance: unknown = JSON.parse(String(nodeRun.stdout));
    expect(childInstance).toEqual({
      port: inProcessInstance.port,
      name: inProcessInstance.name,
    });
    expect(inProcessInstance.port).toBe(4321);
    expect(inProcessInstance.name).toBe("neutral-service");
  }, 120000);
});
