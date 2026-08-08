import { describe, expect, test } from "vitest";
import type { GeneratedResolver } from "@/generated/contracts";
import { classBean, createApplicationContext, factoryBean } from "@/generated-runtime";
import {
  ApplicationContextStateError,
  BeanCreationError,
  type Current,
  defineBean,
  RequestContextMissingError,
  UnregisteredBeanTargetError,
} from "@/index";
import { rejection } from "../test/support/rejection";
import { testDefinition, testDependency, testSource } from "../test/support/test-definition";

// request scope 运行时（ADR 0006 W7，#142 / #151）：请求仓挂在 AsyncLocalStorage 上跟随 await 链；
// runInRequestScope 是"开启请求作用域并播种根请求值"的通用入口（#153 适配器的前身，这里由 IT 直接
// 消费）。请求构造照 requestConstructionOrder 全量执行，无按需构造；请求内记忆化、请求间隔离；
// singleton 经 Current<T> 句柄在调用时刻取值，请求外取值是 REQUEST_CONTEXT_MISSING 硬错。

const clockId = "src/clock.ts#Clock";
const rootId = "src/root.ts#RootContext";
const sessionId = "src/session.ts#Session";
const holderId = "src/holder.ts#Holder";

class Clock {}

class RootContext {
  id = "unseeded";
}

class Session {
  constructor(
    readonly root: RootContext,
    readonly clock: Clock,
  ) {}
}

function clockRegistration() {
  return classBean({
    id: clockId,
    source: testSource("clock"),
    target: Clock,
    dependencies: [],
    create: () => new Clock(),
    hooks: {},
  });
}

function rootRegistration(onCreate?: () => void) {
  return classBean({
    id: rootId,
    source: testSource("root"),
    target: RootContext,
    scope: "request",
    dependencies: [],
    create: () => {
      onCreate?.();
      return new RootContext();
    },
    hooks: {},
  });
}

function sessionRegistration(onCreate?: () => void) {
  return classBean({
    id: sessionId,
    source: testSource("session"),
    target: Session,
    scope: "request",
    dependencies: [testDependency(0, rootId, "eager"), testDependency(1, clockId, "eager")],
    create: (resolver: GeneratedResolver) => {
      onCreate?.();
      return new Session(resolver.resolve(0), resolver.resolve(1));
    },
    hooks: {},
  });
}

class SessionHolder {
  constructor(readonly session: Current<Session>) {}
}

function holderRegistration() {
  return classBean({
    id: holderId,
    source: testSource("holder"),
    target: SessionHolder,
    dependencies: [testDependency(0, sessionId, "current")],
    create: (resolver: GeneratedResolver) => new SessionHolder(resolver.current(0)),
    hooks: {},
  });
}

class RootHolder {
  constructor(readonly root: Current<RootContext>) {}
}

const rootHolderId = "src/root-holder.ts#RootHolder";

function rootHolderRegistration() {
  return classBean({
    id: rootHolderId,
    source: testSource("root-holder"),
    target: RootHolder,
    dependencies: [testDependency(0, rootId, "current")],
    create: (resolver: GeneratedResolver) => new RootHolder(resolver.current(0)),
    hooks: {},
  });
}

async function startedContext(...registrations: Parameters<typeof testDefinition>[0]) {
  const context = createApplicationContext(testDefinition(registrations));
  await context.start();
  return context;
}

function seededRoot(id: string): RootContext {
  const root = new RootContext();
  root.id = id;
  return root;
}

describe("request plan execution", () => {
  test("the plan constructs every request Bean upfront and memoizes within the request", async () => {
    let rootCreations = 0;
    let sessionCreations = 0;
    const context = await startedContext(
      clockRegistration(),
      rootRegistration(() => {
        rootCreations += 1;
      }),
      sessionRegistration(() => {
        sessionCreations += 1;
      }),
      holderRegistration(),
    );
    const holder = context.get(SessionHolder);

    const memoized = await context.runInRequestScope([], () => {
      const first = holder.session.get();
      const second = holder.session.get();
      return first === second;
    });

    expect(memoized).toBe(true);
    expect(rootCreations).toBe(1);
    expect(sessionCreations).toBe(1);
    await context.close();
  });

  test("async factories are awaited one at a time in plan order", async () => {
    const log: string[] = [];
    const first = defineBean<{ readonly marker: string }>({
      scope: "request",
      create: async () => {
        log.push("first:start");
        await Promise.resolve();
        log.push("first:done");
        return { marker: "first" };
      },
    });
    const second = defineBean<{ readonly marker: string }>({
      scope: "request",
      create: async () => {
        log.push("second");
        return { marker: "second" };
      },
    });
    const context = await startedContext(
      factoryBean({ id: "src/first.ts#first", source: testSource("first"), definition: first }),
      factoryBean({ id: "src/second.ts#second", source: testSource("second"), definition: second }),
    );

    await context.runInRequestScope([], () => undefined);

    expect(log).toEqual(["first:start", "first:done", "second"]);
    await context.close();
  });

  test("a request Bean receives the singleton instance the context holds", async () => {
    const context = await startedContext(
      clockRegistration(),
      rootRegistration(),
      sessionRegistration(),
    );

    const clock = await context.runInRequestScope([], () => context.get(Session).clock);

    expect(clock).toBe(context.get(Clock));
    await context.close();
  });

  test("two interleaved requests construct isolated instances", async () => {
    const releases: (() => void)[] = [];
    const trace = defineBean<{ readonly kind: string }>({
      scope: "request",
      create: async () => {
        const { promise, resolve } = Promise.withResolvers<void>();
        releases.push(() => resolve());
        await promise;
        return { kind: "trace" };
      },
    });
    const context = await startedContext(
      clockRegistration(),
      rootRegistration(),
      factoryBean({ id: "src/trace.ts#trace", source: testSource("trace"), definition: trace }),
      rootHolderRegistration(),
    );
    const holder = context.get(RootHolder);
    const read = () => holder.root.get().id;

    const alpha = context.runInRequestScope(
      [{ target: RootContext, instance: seededRoot("alpha") }],
      read,
    );
    const beta = context.runInRequestScope(
      [{ target: RootContext, instance: seededRoot("beta") }],
      read,
    );
    // 请求计划逐边 await,推进要靠微任务;把两个计划都排到 trace 工厂的闸门上再交错放行。
    while (releases.length < 2) {
      await Promise.resolve();
    }
    // 倒序放行两个挂起中的请求计划:完成顺序与开启顺序交错,值仍互不串。
    releases[1]?.();
    releases[0]?.();

    expect(await Promise.all([alpha, beta])).toEqual(["alpha", "beta"]);
    await context.close();
  });

  test("a seed replaces the seeded Bean's construction", async () => {
    let rootCreations = 0;
    const context = await startedContext(
      clockRegistration(),
      rootRegistration(() => {
        rootCreations += 1;
      }),
      sessionRegistration(),
    );

    const observed = await context.runInRequestScope(
      [{ target: RootContext, instance: seededRoot("seeded") }],
      () => context.get(Session).root.id,
    );

    expect(observed).toBe("seeded");
    expect(rootCreations).toBe(0);
    await context.close();
  });

  test("a failing request factory rejects with BeanCreationError", async () => {
    const failing = defineBean<{ readonly marker: string }>({
      scope: "request",
      create: async () => {
        throw new Error("request construction failed");
      },
    });
    const context = await startedContext(
      factoryBean({
        id: "src/failing.ts#failing",
        source: testSource("failing"),
        definition: failing,
      }),
    );

    const error = await rejection(context.runInRequestScope([], () => undefined));

    expect(error).toBeInstanceOf(BeanCreationError);
    if (error instanceof BeanCreationError) {
      expect(error.beanId).toBe("src/failing.ts#failing");
    }
    await context.close();
  });

  test("nested request scopes are independent requests", async () => {
    const context = await startedContext(
      clockRegistration(),
      rootRegistration(),
      rootHolderRegistration(),
    );
    const holder = context.get(RootHolder);
    const read = () => holder.root.get().id;

    const observed = await context.runInRequestScope(
      [{ target: RootContext, instance: seededRoot("outer") }],
      async () => {
        const before = read();
        const inner = await context.runInRequestScope(
          [{ target: RootContext, instance: seededRoot("inner") }],
          read,
        );
        return [before, inner, read()];
      },
    );

    expect(observed).toEqual(["outer", "inner", "outer"]);
    await context.close();
  });
});

describe("current handles and request-scoped access", () => {
  test("Current.get outside an active request names the edge in REQUEST_CONTEXT_MISSING", async () => {
    const context = await startedContext(
      clockRegistration(),
      rootRegistration(),
      sessionRegistration(),
      holderRegistration(),
    );
    const holder = context.get(SessionHolder);

    const read = () => holder.session.get();

    expect(read).toThrow(RequestContextMissingError);
    try {
      read();
    } catch (error) {
      if (!(error instanceof RequestContextMissingError)) {
        throw error;
      }
      expect(error.code).toBe("REQUEST_CONTEXT_MISSING");
      expect(error.targetBeanId).toBe(sessionId);
      expect(error.consumerBeanId).toBe(holderId);
      expect(error.message).toContain(sessionId);
      expect(error.message).toContain(holderId);
    }
    await context.close();
  });

  test("context.get on a request Bean outside a request throws REQUEST_CONTEXT_MISSING", async () => {
    const context = await startedContext(
      clockRegistration(),
      rootRegistration(),
      sessionRegistration(),
    );

    const read = () => context.get(Session);

    expect(read).toThrow(RequestContextMissingError);
    await context.close();
  });

  test("context.get inside a request returns the same instance as the Current handle", async () => {
    const context = await startedContext(
      clockRegistration(),
      rootRegistration(),
      sessionRegistration(),
      holderRegistration(),
    );
    const holder = context.get(SessionHolder);

    const same = await context.runInRequestScope(
      [],
      () => context.get(Session) === holder.session.get(),
    );

    expect(same).toBe(true);
    await context.close();
  });
});

// 请求仓的归属边界（#380）。一份生成物起两个 context 是 testing 与 dev 重启的常态，两边的
// beanId 是同一批字符串，所以「这一仓是谁的」不能靠 id 认——认错的表现不是报错，是 B 的
// 消费方安静地拿到 A 这次请求的实例。请求作用域挪成模块级单例 ALS 之后，这条由 store 上的
// owner 引用比较兜住；本组用例正是那次挪动的校验闸。
describe("request scope ownership across contexts", () => {
  async function twoStartedContexts() {
    const definition = testDefinition([
      clockRegistration(),
      rootRegistration(),
      rootHolderRegistration(),
    ]);
    const alpha = createApplicationContext(definition);
    const beta = createApplicationContext(definition);
    await Promise.all([alpha.start(), beta.start()]);
    return { alpha, beta };
  }

  test("context.get on another context's request Bean reports no active request", async () => {
    const { alpha, beta } = await twoStartedContexts();

    await alpha.runInRequestScope([{ target: RootContext, instance: seededRoot("alpha") }], () => {
      expect(() => beta.get(RootContext)).toThrow(RequestContextMissingError);
    });

    await Promise.all([alpha.close(), beta.close()]);
  });

  test("a Current handle of another context reports no active request", async () => {
    const { alpha, beta } = await twoStartedContexts();
    const betaHolder = beta.get(RootHolder);

    await alpha.runInRequestScope([{ target: RootContext, instance: seededRoot("alpha") }], () => {
      expect(() => betaHolder.root.get()).toThrow(RequestContextMissingError);
    });

    await Promise.all([alpha.close(), beta.close()]);
  });
});

describe("request scope entry validation", () => {
  test("runInRequestScope requires a running context", async () => {
    const context = createApplicationContext(
      testDefinition([clockRegistration(), rootRegistration()]),
    );

    const error = await rejection(context.runInRequestScope([], () => undefined));

    expect(error).toBeInstanceOf(ApplicationContextStateError);
  });

  test("a seed for an unregistered target is rejected", async () => {
    const context = await startedContext(clockRegistration(), rootRegistration());

    const error = await rejection(
      context.runInRequestScope(
        [{ target: Session, instance: new Session(seededRoot("x"), new Clock()) }],
        () => undefined,
      ),
    );

    expect(error).toBeInstanceOf(UnregisteredBeanTargetError);
    await context.close();
  });

  test("a seed for a singleton Bean is rejected", async () => {
    const context = await startedContext(clockRegistration(), rootRegistration());

    const error = await rejection(
      context.runInRequestScope([{ target: Clock, instance: new Clock() }], () => undefined),
    );

    expect(error).toBeInstanceOf(TypeError);
    await context.close();
  });

  test("a class seed must be an instance of its target", async () => {
    const context = await startedContext(clockRegistration(), rootRegistration());

    const error = await rejection(
      context.runInRequestScope(
        [
          {
            target: RootContext,
            // 负向用例故意伪造类型错误的种子，运行时 instanceof 校验必须接住它。
            instance: new Clock() as unknown as RootContext,
          },
        ],
        () => undefined,
      ),
    );

    expect(error).toBeInstanceOf(TypeError);
    await context.close();
  });

  test("duplicate seed targets are rejected", async () => {
    const context = await startedContext(clockRegistration(), rootRegistration());

    const error = await rejection(
      context.runInRequestScope(
        [
          { target: RootContext, instance: seededRoot("first") },
          { target: RootContext, instance: seededRoot("second") },
        ],
        () => undefined,
      ),
    );

    expect(error).toBeInstanceOf(TypeError);
    await context.close();
  });
});
