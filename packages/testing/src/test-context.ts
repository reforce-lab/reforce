import {
  type ApplicationContext,
  type BeanClass,
  type BeanDefinition,
  UnregisteredBeanTargetError,
} from "@reforce/context";
import {
  createApplicationContext,
  type GeneratedApplicationDefinition,
  type GeneratedBeanRegistration,
} from "@reforce/context/generated-runtime";

export interface TestContextOverrides {
  // NoInfer 把 T 的推断钉在 target 上（ADR 0007 T2，#143）：若替身也参与推断，
  // TS 会把 T 放宽成两者的联合类型，结构不兼容的替身就不再是编译错。
  replace<T extends object>(
    target: BeanClass<T> | BeanDefinition<T>,
    replacement: NoInfer<T>,
  ): void;
}

export async function createTestContext(
  definition: GeneratedApplicationDefinition,
  configure: (overrides: TestContextOverrides) => void,
): Promise<ApplicationContext> {
  const replacementByTarget = collectReplacements(configure);
  const context = createApplicationContext(applyReplacements(definition, replacementByTarget));
  await context.start();
  return context;
}

function isPrimitiveValue(value: unknown): boolean {
  return value === null || (typeof value !== "object" && typeof value !== "function");
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

// replace 的实参是测试代码手写的，与 defineBean 同策略做运行时守卫：未经编译的 JS
// 调用方拿不到编译期诊断，这里必须立刻失败而不是留到启动期再炸。
function collectReplacements(
  configure: (overrides: TestContextOverrides) => void,
): Map<object, object> {
  const replacementByTarget = new Map<object, object>();
  let collecting = true;
  const overrides: TestContextOverrides = {
    replace(target, replacement) {
      if (!collecting) {
        throw new TypeError("replace must be called synchronously inside the configure callback.");
      }
      if (isPrimitiveValue(target)) {
        throw new TypeError("replace target must be a Bean Class or a defineBean() definition.");
      }
      if (isPrimitiveValue(replacement)) {
        throw new TypeError("replace replacement must be an object.");
      }
      if (replacementByTarget.has(target)) {
        throw new TypeError("replace was already called for this Bean target.");
      }
      replacementByTarget.set(target, replacement);
    },
  };
  const outcome: unknown = configure(overrides);
  collecting = false;
  if (isRecord(outcome) && typeof outcome.then === "function") {
    throw new TypeError(
      "configure callback must be synchronous: replacements registered after an await would be silently lost.",
    );
  }
  return replacementByTarget;
}

function applyReplacements(
  definition: GeneratedApplicationDefinition,
  replacementByTarget: ReadonlyMap<object, object>,
): GeneratedApplicationDefinition {
  if (replacementByTarget.size === 0) {
    return definition;
  }
  const unmatched = new Map(replacementByTarget);
  const registrations = definition.registrations.map((registration) => {
    const identity = beanIdentity(registration);
    const replacement = identity === undefined ? undefined : unmatched.get(identity);
    if (identity === undefined || replacement === undefined) {
      return registration;
    }
    unmatched.delete(identity);
    return replaceCreate(registration, replacement);
  });
  const missing = unmatched.keys().next();
  if (!missing.done) {
    throw new UnregisteredBeanTargetError(missing.value);
  }
  return {
    schemaVersion: definition.schemaVersion,
    // config 注册与绑定 phase 原样透传（ADR 0005，#130）：替换只针对 bean 的 create，
    // config 实例由绑定 phase 产生，替换语义待真实需求再立项。
    configs: definition.configs,
    ...(definition.configBinding ? { configBinding: definition.configBinding } : {}),
    registrations,
    plans: definition.plans,
  };
}

// 形状不对的 registration 不在这里诊断：testing 不新增任何校验通道（ADR 0007 T3），
// 原样放行让 createApplicationContext 的既有结构校验报出规范错误。
function beanIdentity(registration: GeneratedBeanRegistration): object | undefined {
  if (!isRecord(registration)) {
    return undefined;
  }
  return registration.kind === "class" ? registration.target : registration.definition;
}

const noopLifecycleAction = (): void => undefined;

// ADR 0007 T3（#143）：替换只发生在 create——依赖边与 plans 原样保留，替身不经 resolver
// 构造，其余 bean 照常构造。钩子与 dispose 不能删除（结构校验要求 plans 的 start/cleanup
// 名单与钩子存在性精确对齐，删除即校验失败），因此原有钩子替换为 no-op：被替换 bean 的
// 生命周期由测试代码自己管理，替身即使带同名钩子方法也不会被上下文调用。
function replaceCreate(
  registration: GeneratedBeanRegistration,
  replacement: object,
): GeneratedBeanRegistration {
  if (registration.kind === "class") {
    return {
      kind: "class",
      id: registration.id,
      source: registration.source,
      target: registration.target,
      dependencies: registration.dependencies,
      create: () => replacement,
      hooks: {
        start: registration.hooks.start ? noopLifecycleAction : undefined,
        close: registration.hooks.close ? noopLifecycleAction : undefined,
      },
    };
  }
  return {
    kind: "factory",
    id: registration.id,
    source: registration.source,
    definition: registration.definition,
    dependencies: registration.dependencies,
    create: () => replacement,
    dispose: registration.dispose ? noopLifecycleAction : undefined,
  };
}
