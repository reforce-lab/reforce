import { describe, expect, test } from "vitest";
import {
  classBean,
  configBean,
  createApplicationContext,
  type GeneratedConfigBinding,
  type GeneratedConfigBindingOutcome,
  type GeneratedConfigRegistration,
} from "@/generated-runtime";
import { ApplicationStartError, ConfigBindingError, type ConfigBindingIssue } from "@/index";
import { testDefinition, testSource } from "../test/support/test-definition";

class ServerConfig {
  readonly port: number;

  constructor(values: { readonly port: number }) {
    this.port = values.port;
  }
}

class MetricsConfig {
  readonly endpoint: string;

  constructor(values: { readonly endpoint: string }) {
    this.endpoint = values.endpoint;
  }
}

const serverConfigId = "src/server-config.ts#ServerConfig";
const metricsConfigId = "src/metrics-config.ts#MetricsConfig";

function serverConfigRegistration(): GeneratedConfigRegistration {
  return configBean({
    id: serverConfigId,
    source: testSource("server-config"),
    target: ServerConfig,
  });
}

function metricsConfigRegistration(): GeneratedConfigRegistration {
  return configBean({
    id: metricsConfigId,
    source: testSource("metrics-config"),
    target: MetricsConfig,
  });
}

function bindingOf(
  handler: (
    configs: readonly GeneratedConfigRegistration[],
  ) => Promise<GeneratedConfigBindingOutcome>,
): GeneratedConfigBinding {
  return { bind: handler };
}

function boundBinding(events?: string[]): GeneratedConfigBinding {
  return bindingOf((configs) => {
    events?.push("bind");
    const instances = new Map<string, object>();
    for (const config of configs) {
      if (config.target === ServerConfig) {
        instances.set(config.id, new ServerConfig({ port: 8080 }));
        continue;
      }
      instances.set(config.id, new MetricsConfig({ endpoint: "https://metrics.local" }));
    }
    return Promise.resolve({ status: "bound", instances });
  });
}

const issueFixtures: readonly ConfigBindingIssue[] = [
  {
    configId: serverConfigId,
    keyPath: ["port"],
    environmentVariable: "SERVER_PORT",
    layer: ".env.production",
    reason: "Expected number, received string.",
  },
  {
    configId: metricsConfigId,
    keyPath: ["endpoint"],
    environmentVariable: "METRICS_ENDPOINT",
    layer: "process-env",
    reason: "Invalid url.",
  },
];

describe("config binding phase", () => {
  test("binds every config class before any bean constructs", async () => {
    const events: string[] = [];
    class Consumer {
      constructor(readonly config: ServerConfig) {}
    }
    const definition = testDefinition(
      [
        classBean({
          id: "src/consumer.ts#Consumer",
          source: testSource("consumer"),
          target: Consumer,
          dependencies: [
            {
              parameterIndex: 0,
              targetId: serverConfigId,
              mode: "eager",
              source: testSource("consumer-parameter"),
            },
          ],
          create: (resolver) => {
            events.push("construct");
            return new Consumer(resolver.resolve<ServerConfig>(0));
          },
          hooks: {},
        }),
      ],
      {
        configs: [serverConfigRegistration()],
        configBinding: boundBinding(events),
      },
    );
    const context = createApplicationContext(definition);

    await context.start();

    expect(events).toEqual(["bind", "construct"]);
    expect(context.get(Consumer).config.port).toBe(8080);
    await context.close();
  });

  test("exposes bound config instances through context.get", async () => {
    const definition = testDefinition([], {
      configs: [serverConfigRegistration(), metricsConfigRegistration()],
      configBinding: boundBinding(),
    });
    const context = createApplicationContext(definition);

    await context.start();

    expect(context.get(ServerConfig).port).toBe(8080);
    expect(context.get(MetricsConfig).endpoint).toBe("https://metrics.local");
    await context.close();
  });

  test("keeps config instances isolated between two contexts over one definition", async () => {
    const definition = testDefinition([], {
      configs: [serverConfigRegistration()],
      configBinding: boundBinding(),
    });
    const first = createApplicationContext(definition);
    const second = createApplicationContext(definition);

    await Promise.all([first.start(), second.start()]);

    expect(first.get(ServerConfig)).not.toBe(second.get(ServerConfig));
    await Promise.all([first.close(), second.close()]);
  });

  test("aggregates every binding issue into one ConfigBindingError start failure", async () => {
    let constructed = 0;
    class Consumer {
      constructor() {
        constructed += 1;
      }
    }
    const definition = testDefinition(
      [
        classBean({
          id: "src/consumer.ts#Consumer",
          source: testSource("consumer"),
          target: Consumer,
          dependencies: [],
          create: () => new Consumer(),
          hooks: {},
        }),
      ],
      {
        configs: [serverConfigRegistration(), metricsConfigRegistration()],
        configBinding: bindingOf(() =>
          Promise.resolve({ status: "failed", issues: issueFixtures }),
        ),
      },
    );
    const context = createApplicationContext(definition);

    const startError = await context.start().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(startError).toBeInstanceOf(ApplicationStartError);
    const cause = (startError as ApplicationStartError).cause;
    expect(cause).toBeInstanceOf(ConfigBindingError);
    const bindingError = cause as ConfigBindingError;
    expect(bindingError.code).toBe("CONFIG_BINDING_FAILED");
    expect(bindingError.issues).toEqual(issueFixtures);
    expect(Object.isFrozen(bindingError.issues)).toBe(true);
    expect(bindingError.message).toContain("SERVER_PORT");
    expect(bindingError.message).toContain("METRICS_ENDPOINT");
    expect(bindingError.message).toContain(".env.production");
    expect(constructed).toBe(0);
    await context.close();
  });

  test("rejects a bound outcome that omits an instance for a declared config", async () => {
    const definition = testDefinition([], {
      configs: [serverConfigRegistration(), metricsConfigRegistration()],
      configBinding: bindingOf((configs) => {
        const first = configs[0];
        const instances = new Map<string, object>();
        if (first) {
          instances.set(first.id, new ServerConfig({ port: 1 }));
        }
        return Promise.resolve({ status: "bound", instances });
      }),
    });
    const context = createApplicationContext(definition);

    const startError = await context.start().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(startError).toBeInstanceOf(ApplicationStartError);
    expect((startError as ApplicationStartError).cause.message).toContain(metricsConfigId);
    await context.close();
  });

  test("rejects a bound instance that is not created from the registered class", async () => {
    const definition = testDefinition([], {
      configs: [serverConfigRegistration()],
      configBinding: bindingOf((configs) => {
        const instances = new Map<string, object>();
        for (const config of configs) {
          instances.set(config.id, { port: 8080 });
        }
        return Promise.resolve({ status: "bound", instances });
      }),
    });
    const context = createApplicationContext(definition);

    const startError = await context.start().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(startError).toBeInstanceOf(ApplicationStartError);
    expect((startError as ApplicationStartError).cause.message).toContain(serverConfigId);
    await context.close();
  });
});
