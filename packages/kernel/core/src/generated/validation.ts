import { isObject } from "radashi";
import { InvalidGeneratedDefinitionError } from "@/errors";
import type {
  GeneratedApplicationDefinition,
  GeneratedBeanRegistration,
  GeneratedClassRegistration,
  GeneratedCollectionDependency,
  GeneratedCollectionMember,
  GeneratedConfigBindingOutcome,
  GeneratedConfigRegistration,
  GeneratedDependency,
  GeneratedFactoryRegistration,
  GeneratedSingleDependency,
  GeneratedSourcePosition,
  GeneratedSourceReference,
} from "@/generated/contracts";

const singleDependencyModes = new Set(["eager", "cycle-proxy", "explicit-lazy", "current"]);
const collectionMemberModes = new Set(["eager", "cycle-proxy"]);

function fail(detail: string): never {
  throw new InvalidGeneratedDefinitionError(detail);
}

function requireObject(value: unknown, path: string): object {
  if (!isObject(value)) {
    return fail(`${path} must be an object.`);
  }
  return value;
}

function requireExactKeys(value: object, allowed: readonly string[], path: string): void {
  const allowedKeys = new Set<PropertyKey>(allowed);
  for (const key of Reflect.ownKeys(value)) {
    if (!allowedKeys.has(key)) {
      fail(`${path} contains unknown field "${String(key)}".`);
    }
  }
}

function requireArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    return fail(`${path} must be an array.`);
  }
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    return fail(`${path} must be a string.`);
  }
  return value;
}

function requireFunction(value: unknown, path: string): void {
  if (typeof value !== "function") {
    fail(`${path} must be a function.`);
  }
}

function requireNonNegativeInteger(value: unknown, path: string): number {
  // The typeof check is runtime-redundant (Number.isInteger implies it) but
  // required for TypeScript narrowing, so it stays first to narrow value.
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return fail(`${path} must be a non-negative integer.`);
  }
  return value;
}

function validateRelativePosixPath(value: string, path: string): void {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    /^[A-Za-z]:/.test(value)
  ) {
    fail(`${path} must be a relative POSIX path.`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail(`${path} must not contain empty, current, or parent segments.`);
  }
}

function validateGeneratedBeanId(value: unknown, path: string): string {
  const id = requireString(value, path);
  const separator = id.indexOf("#");
  if (separator <= 0 || separator !== id.lastIndexOf("#") || separator === id.length - 1) {
    return fail(`${path} must contain one non-edge # separator.`);
  }
  validateRelativePosixPath(id.slice(0, separator), `${path} file part`);
  return id;
}

function validateBeanScope(value: unknown, path: string): "singleton" | "request" {
  if (value === "singleton" || value === "request") {
    return value;
  }
  return fail(`${path}.scope must be "singleton" or "request".`);
}

function validateSourcePosition(
  value: unknown,
  path: string,
): asserts value is GeneratedSourcePosition {
  const position = requireObject(value, path);
  requireExactKeys(position, ["offset", "line", "character"], path);
  requireNonNegativeInteger(Reflect.get(position, "offset"), `${path}.offset`);
  requireNonNegativeInteger(Reflect.get(position, "line"), `${path}.line`);
  requireNonNegativeInteger(Reflect.get(position, "character"), `${path}.character`);
}

function validateSourceReference(
  value: unknown,
  path: string,
): asserts value is GeneratedSourceReference {
  const source = requireObject(value, path);
  requireExactKeys(source, ["file", "start", "end"], path);
  const file = requireString(Reflect.get(source, "file"), `${path}.file`);
  validateRelativePosixPath(file, `${path}.file`);
  const start = Reflect.get(source, "start");
  const end = Reflect.get(source, "end");
  validateSourcePosition(start, `${path}.start`);
  validateSourcePosition(end, `${path}.end`);
  if (end.offset < start.offset) {
    return fail(`${path}.end.offset must not precede start.offset.`);
  }
}

function validateParameterIndex(dependency: object, index: number, path: string): void {
  const parameterIndex = requireNonNegativeInteger(
    Reflect.get(dependency, "parameterIndex"),
    `${path}.parameterIndex`,
  );
  if (parameterIndex !== index) {
    fail(`${path}.parameterIndex must equal its array index.`);
  }
}

function validateCollectionMember(
  value: unknown,
  path: string,
): asserts value is GeneratedCollectionMember {
  const member = requireObject(value, path);
  requireExactKeys(member, ["targetId", "mode"], path);
  validateGeneratedBeanId(Reflect.get(member, "targetId"), `${path}.targetId`);
  const mode = Reflect.get(member, "mode");
  if (typeof mode !== "string" || !collectionMemberModes.has(mode)) {
    return fail(`${path}.mode is unknown.`);
  }
}

function validateCollectionDependency(
  dependency: object,
  index: number,
  path: string,
): asserts dependency is GeneratedCollectionDependency {
  requireExactKeys(dependency, ["parameterIndex", "mode", "members", "source"], path);
  validateParameterIndex(dependency, index, path);
  const members = requireArray(Reflect.get(dependency, "members"), `${path}.members`);
  const seen = new Set<string>();
  for (const [memberIndex, member] of members.entries()) {
    const memberPath = `${path}.members[${memberIndex}]`;
    validateCollectionMember(member, memberPath);
    if (seen.has(member.targetId)) {
      fail(`${path}.members contains duplicate target "${member.targetId}".`);
    }
    seen.add(member.targetId);
  }
  validateSourceReference(Reflect.get(dependency, "source"), `${path}.source`);
}

function validateSingleDependency(
  dependency: object,
  index: number,
  path: string,
): asserts dependency is GeneratedSingleDependency {
  requireExactKeys(dependency, ["parameterIndex", "targetId", "mode", "source"], path);
  validateParameterIndex(dependency, index, path);
  validateGeneratedBeanId(Reflect.get(dependency, "targetId"), `${path}.targetId`);
  const mode = Reflect.get(dependency, "mode");
  if (typeof mode !== "string" || !singleDependencyModes.has(mode)) {
    return fail(`${path}.mode is unknown.`);
  }
  validateSourceReference(Reflect.get(dependency, "source"), `${path}.source`);
}

function validateDependency(
  value: unknown,
  index: number,
  path: string,
): asserts value is GeneratedDependency {
  const dependency = requireObject(value, path);
  if (Reflect.get(dependency, "mode") === "collection") {
    validateCollectionDependency(dependency, index, path);
    return;
  }
  validateSingleDependency(dependency, index, path);
}

function validateDependencies(value: unknown, path: string): readonly unknown[] {
  const dependencies = requireArray(value, path);
  for (const [index, dependency] of dependencies.entries()) {
    validateDependency(dependency, index, `${path}[${index}]`);
  }
  return dependencies;
}

function validateHooks(value: unknown, path: string): void {
  const hooks = requireObject(value, path);
  requireExactKeys(hooks, ["start", "close"], path);
  const start = Reflect.get(hooks, "start");
  if (start !== undefined) {
    requireFunction(start, `${path}.start`);
  }
  const close = Reflect.get(hooks, "close");
  if (close !== undefined) {
    requireFunction(close, `${path}.close`);
  }
}

function validateClassRegistrationLocal(
  value: unknown,
  path = "class registration",
): asserts value is GeneratedClassRegistration {
  const registration = requireObject(value, path);
  requireExactKeys(
    registration,
    ["kind", "id", "source", "scope", "target", "dependencies", "create", "hooks"],
    path,
  );
  if (Reflect.get(registration, "kind") !== "class") {
    return fail(`${path}.kind must be "class".`);
  }
  validateGeneratedBeanId(Reflect.get(registration, "id"), `${path}.id`);
  validateSourceReference(Reflect.get(registration, "source"), `${path}.source`);
  const scope = validateBeanScope(Reflect.get(registration, "scope"), path);
  requireFunction(Reflect.get(registration, "target"), `${path}.target`);
  requireFunction(Reflect.get(registration, "create"), `${path}.create`);
  validateDependencies(Reflect.get(registration, "dependencies"), `${path}.dependencies`);
  validateHooks(Reflect.get(registration, "hooks"), `${path}.hooks`);
  // 请求 bean 没有 context 级生命周期（ADR 0006 W7）：start action 先于任何请求，cleanup
  // 账本按 bean 记一次，二者都以 singleton 实例为前提。
  const hooks = requireObject(Reflect.get(registration, "hooks"), `${path}.hooks`);
  if (
    scope === "request" &&
    (Reflect.get(hooks, "start") !== undefined || Reflect.get(hooks, "close") !== undefined)
  ) {
    fail(`${path} is request-scoped and cannot declare lifecycle hooks.`);
  }
}

function validateFactoryRegistrationLocal(
  value: unknown,
  path = "factory registration",
): asserts value is GeneratedFactoryRegistration {
  const registration = requireObject(value, path);
  requireExactKeys(
    registration,
    ["kind", "id", "source", "scope", "definition", "dependencies", "create", "dispose"],
    path,
  );
  if (Reflect.get(registration, "kind") !== "factory") {
    return fail(`${path}.kind must be "factory".`);
  }
  validateGeneratedBeanId(Reflect.get(registration, "id"), `${path}.id`);
  validateSourceReference(Reflect.get(registration, "source"), `${path}.source`);
  const scope = validateBeanScope(Reflect.get(registration, "scope"), path);
  if (scope === "request" && Reflect.get(registration, "dispose") !== undefined) {
    return fail(`${path} is request-scoped and cannot declare dispose.`);
  }
  if (!isObject(Reflect.get(registration, "definition"))) {
    return fail(`${path}.definition must be an object identity.`);
  }
  requireFunction(Reflect.get(registration, "create"), `${path}.create`);
  const dependencies = validateDependencies(
    Reflect.get(registration, "dependencies"),
    `${path}.dependencies`,
  );
  if (dependencies.length !== 0) {
    return fail(`${path}.dependencies must be empty.`);
  }
  const dispose = Reflect.get(registration, "dispose");
  if (dispose !== undefined) {
    requireFunction(dispose, `${path}.dispose`);
  }
}

function validateConfigRegistrationLocal(
  value: unknown,
  path = "config registration",
): asserts value is GeneratedConfigRegistration {
  const registration = requireObject(value, path);
  requireExactKeys(registration, ["kind", "id", "source", "target"], path);
  if (Reflect.get(registration, "kind") !== "config") {
    return fail(`${path}.kind must be "config".`);
  }
  validateGeneratedBeanId(Reflect.get(registration, "id"), `${path}.id`);
  validateSourceReference(Reflect.get(registration, "source"), `${path}.source`);
  requireFunction(Reflect.get(registration, "target"), `${path}.target`);
}

function validateRegistration(
  value: unknown,
  index: number,
): asserts value is GeneratedBeanRegistration {
  const registration = requireObject(value, `registrations[${index}]`);
  if (Reflect.get(registration, "kind") === "class") {
    validateClassRegistrationLocal(registration, `registrations[${index}]`);
    return;
  }
  if (Reflect.get(registration, "kind") === "factory") {
    validateFactoryRegistrationLocal(registration, `registrations[${index}]`);
    return;
  }
  return fail(`registrations[${index}].kind is unknown.`);
}

function validatePlanArray(
  value: unknown,
  path: string,
  knownIds: ReadonlySet<string>,
): readonly string[] {
  const plan = requireArray(value, path);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const [index, item] of plan.entries()) {
    const id = requireString(item, `${path}[${index}]`);
    if (!knownIds.has(id)) {
      return fail(`${path}[${index}] references an unknown Bean ID.`);
    }
    if (seen.has(id)) {
      return fail(`${path} contains duplicate Bean ID "${id}".`);
    }
    seen.add(id);
    result.push(id);
  }
  return result;
}

function requireSameSet(
  actual: readonly string[],
  expected: ReadonlySet<string>,
  path: string,
): void {
  if (actual.length !== expected.size || actual.some((id) => !expected.has(id))) {
    fail(`${path} does not exactly cover its required actions.`);
  }
}

function validateEagerEdgePosition(
  planName: string,
  edge: { readonly targetId: string; readonly mode: string },
  consumerId: string,
  consumerIndex: number,
  constructionIndex: ReadonlyMap<string, number>,
  alwaysReadyIds: ReadonlySet<string>,
): void {
  // Config instances are bound before the construction loop starts, and every singleton is
  // constructed before any request plan runs, so edges onto always-ready ids are satisfied
  // regardless of the consumer's plan position.
  if (edge.mode !== "eager" || alwaysReadyIds.has(edge.targetId)) {
    return;
  }
  const dependencyIndex = constructionIndex.get(edge.targetId);
  if (dependencyIndex === undefined || dependencyIndex >= consumerIndex) {
    fail(
      `plans.${planName} must place eager dependency "${edge.targetId}" before "${consumerId}".`,
    );
  }
}

function validateEagerConstructionPositions(
  planName: string,
  order: readonly string[],
  registrations: readonly GeneratedBeanRegistration[],
  alwaysReadyIds: ReadonlySet<string>,
): void {
  const constructionIndex = new Map(order.map((id, index) => [id, index]));
  for (const registration of registrations) {
    const consumerIndex = constructionIndex.get(registration.id);
    // Unreachable at runtime (requireSameSet already proved the plan covers every
    // registration), but Map.get is typed `number | undefined` and the comparison below
    // needs a number, so this guard exists to narrow it.
    if (consumerIndex === undefined) {
      fail(`plans.${planName} omits "${registration.id}".`);
    }
    for (const dependency of registration.dependencies) {
      for (const edge of dependencyEdges(dependency)) {
        validateEagerEdgePosition(
          planName,
          edge,
          registration.id,
          consumerIndex,
          constructionIndex,
          alwaysReadyIds,
        );
      }
    }
  }
}

function validatePlans(
  value: unknown,
  registrations: readonly GeneratedBeanRegistration[],
  configIds: ReadonlySet<string>,
): void {
  const plans = requireObject(value, "plans");
  requireExactKeys(
    plans,
    ["constructionOrder", "requestConstructionOrder", "startActionOrder", "cleanupActionOrder"],
    "plans",
  );
  const knownIds = new Set(registrations.map((registration) => registration.id));
  // 计划按 scope 分组精确覆盖（ADR 0006 W7）：singleton 计划与请求计划互不越界，
  // 请求计划把 config 与全部 singleton 视为恒就绪。
  const singletonRegistrations = registrations.filter(
    (registration) => registration.scope === "singleton",
  );
  const requestRegistrations = registrations.filter(
    (registration) => registration.scope === "request",
  );
  const singletonIds = new Set(singletonRegistrations.map((registration) => registration.id));
  const requestIds = new Set(requestRegistrations.map((registration) => registration.id));
  const constructionOrder = validatePlanArray(
    Reflect.get(plans, "constructionOrder"),
    "plans.constructionOrder",
    knownIds,
  );
  requireSameSet(constructionOrder, singletonIds, "plans.constructionOrder");
  validateEagerConstructionPositions(
    "constructionOrder",
    constructionOrder,
    singletonRegistrations,
    configIds,
  );

  const requestConstructionOrder = validatePlanArray(
    Reflect.get(plans, "requestConstructionOrder"),
    "plans.requestConstructionOrder",
    knownIds,
  );
  requireSameSet(requestConstructionOrder, requestIds, "plans.requestConstructionOrder");
  validateEagerConstructionPositions(
    "requestConstructionOrder",
    requestConstructionOrder,
    requestRegistrations,
    new Set([...configIds, ...singletonIds]),
  );

  const expectedStart = new Set(
    registrations.flatMap((registration) =>
      registration.kind === "class" && registration.hooks.start ? [registration.id] : [],
    ),
  );
  const startActionOrder = validatePlanArray(
    Reflect.get(plans, "startActionOrder"),
    "plans.startActionOrder",
    knownIds,
  );
  requireSameSet(startActionOrder, expectedStart, "plans.startActionOrder");

  const expectedCleanup = new Set(
    registrations.flatMap((registration) => {
      if (registration.kind === "class" && registration.hooks.close) {
        return [registration.id];
      }
      if (registration.kind === "factory" && registration.dispose) {
        return [registration.id];
      }
      return [];
    }),
  );
  const cleanupActionOrder = validatePlanArray(
    Reflect.get(plans, "cleanupActionOrder"),
    "plans.cleanupActionOrder",
    knownIds,
  );
  requireSameSet(cleanupActionOrder, expectedCleanup, "plans.cleanupActionOrder");
}

function validateRegistrationIdentities(
  registrations: readonly GeneratedBeanRegistration[],
  configs: readonly GeneratedConfigRegistration[],
): void {
  const ids = new Set<string>();
  const portableIds = new Set<string>();
  const classTargets = new Set<object>();
  const factoryDefinitions = new Set<object>();
  const claimIdentity = (id: string) => {
    if (ids.has(id)) {
      fail(`registration ID "${id}" is duplicated.`);
    }
    ids.add(id);
    const portableId = id.toLowerCase();
    if (portableIds.has(portableId)) {
      fail(`registration ID "${id}" has a portable case collision.`);
    }
    portableIds.add(portableId);
  };
  const claimClassTarget = (id: string, target: object) => {
    if (classTargets.has(target)) {
      fail(`class target for "${id}" is duplicated.`);
    }
    classTargets.add(target);
  };
  for (const registration of registrations) {
    claimIdentity(registration.id);
    if (registration.kind === "class") {
      claimClassTarget(registration.id, registration.target);
      continue;
    }
    if (factoryDefinitions.has(registration.definition)) {
      fail(`factory definition for "${registration.id}" is duplicated.`);
    }
    factoryDefinitions.add(registration.definition);
  }
  for (const config of configs) {
    claimIdentity(config.id);
    claimClassTarget(config.id, config.target);
  }
}

// 计划与目标校验只关心"这条边最终指向谁、以什么模式"；集合边按成员展开成同构的目标边，
// 保留成员身份——集合成员的 scope 规则比单边更紧（request bean 不入集合，ADR 0006 W7）。
interface DependencyEdge {
  readonly targetId: string;
  readonly mode: string;
  readonly collectionMember: boolean;
}

function dependencyEdges(dependency: GeneratedDependency): readonly DependencyEdge[] {
  return dependency.mode === "collection"
    ? dependency.members.map((member) => ({
        targetId: member.targetId,
        mode: member.mode,
        collectionMember: true,
      }))
    : [{ targetId: dependency.targetId, mode: dependency.mode, collectionMember: false }];
}

// 跨作用域边规则（ADR 0006 W7）：current 是 singleton→request 的唯一通道；到 request 目标的
// 其余合法形态只有"request 消费者的 eager 单边"。镜像编译器 scope-rules 的裁决，产物字节
// 可能被手改，此处按线上协议复检。
function validateTargetEdge(
  edge: DependencyEdge,
  consumer: GeneratedBeanRegistration,
  scopeById: ReadonlyMap<string, string>,
  configIds: ReadonlySet<string>,
): void {
  if (configIds.has(edge.targetId)) {
    if (edge.mode !== "eager") {
      fail(`dependency of "${consumer.id}" onto config "${edge.targetId}" must be eager.`);
    }
    return;
  }
  const targetScope = scopeById.get(edge.targetId);
  if (targetScope === undefined) {
    fail(`dependency of "${consumer.id}" references unknown Bean "${edge.targetId}".`);
  }
  if (edge.mode === "current") {
    if (consumer.scope !== "singleton") {
      fail(`current dependency of "${consumer.id}" must belong to a singleton Bean.`);
    }
    if (targetScope !== "request") {
      fail(
        `current dependency of "${consumer.id}" must target a request-scoped Bean, not "${edge.targetId}".`,
      );
    }
    return;
  }
  if (targetScope !== "request") {
    return;
  }
  if (edge.collectionMember) {
    fail(`collection member of "${consumer.id}" cannot target request-scoped "${edge.targetId}".`);
  }
  if (consumer.scope !== "request" || edge.mode !== "eager") {
    fail(
      `dependency of "${consumer.id}" onto request-scoped "${edge.targetId}" must be an eager edge from a request-scoped Bean.`,
    );
  }
}

function validateDependencyTargets(
  registrations: readonly GeneratedBeanRegistration[],
  configIds: ReadonlySet<string>,
): void {
  const scopeById = new Map(
    registrations.map((registration) => [registration.id, registration.scope]),
  );
  for (const registration of registrations) {
    for (const dependency of registration.dependencies) {
      for (const edge of dependencyEdges(dependency)) {
        validateTargetEdge(edge, registration, scopeById, configIds);
      }
    }
  }
}

function validateConfigBinding(
  definition: object,
  configs: readonly GeneratedConfigRegistration[],
): void {
  const binding = Reflect.get(definition, "configBinding");
  if (configs.length === 0) {
    if (binding !== undefined) {
      fail("definition.configBinding requires a non-empty configs list.");
    }
    return;
  }
  const bindingObject = requireObject(binding, "definition.configBinding");
  requireFunction(Reflect.get(bindingObject, "bind"), "definition.configBinding.bind");
}

// 信任边界（#314）：configBinding 的实现在 core 之外（ADR 0005），定义校验只验到
// "bind 是函数"，bind 的返回值是整条生成物校验链上唯一未经复检的数据，按不可信输入验形。
// 校验深度与本文件其余条目一致：验结构与判别字段，不下钻 issues 成员与实例内容。
export function validateConfigBindingOutcome(
  value: unknown,
): asserts value is GeneratedConfigBindingOutcome {
  const path = "configBinding.bind outcome";
  const outcome = requireObject(value, path);
  const status = Reflect.get(outcome, "status");
  if (status === "failed") {
    requireExactKeys(outcome, ["status", "issues"], path);
    requireArray(Reflect.get(outcome, "issues"), `${path}.issues`);
    return;
  }
  if (status === "bound") {
    requireExactKeys(outcome, ["status", "instances"], path);
    // isObject 不认 Map（radashi 只认 plain object 与非内建类实例），这里按 Map 接口检查。
    const instances = Reflect.get(outcome, "instances");
    if (
      instances === null ||
      typeof instances !== "object" ||
      typeof Reflect.get(instances, "get") !== "function"
    ) {
      fail(`${path}.instances must be a Map-like object.`);
    }
    return;
  }
  return fail(`${path}.status must be "bound" or "failed".`);
}

function validateApplicationDefinition(value: unknown): void {
  const definition = requireObject(value, "definition");
  requireExactKeys(
    definition,
    ["schemaVersion", "configs", "configBinding", "registrations", "plans"],
    "definition",
  );
  if (Reflect.get(definition, "schemaVersion") !== 6) {
    fail("definition.schemaVersion must be 6.");
  }
  const configCandidates = requireArray(Reflect.get(definition, "configs"), "definition.configs");
  const configs: GeneratedConfigRegistration[] = [];
  for (const [index, config] of configCandidates.entries()) {
    validateConfigRegistrationLocal(config, `configs[${index}]`);
    configs.push(config);
  }
  validateConfigBinding(definition, configs);
  const registrationCandidates = requireArray(
    Reflect.get(definition, "registrations"),
    "definition.registrations",
  );
  const registrations: GeneratedBeanRegistration[] = [];
  for (const [index, registration] of registrationCandidates.entries()) {
    validateRegistration(registration, index);
    registrations.push(registration);
  }

  validateRegistrationIdentities(registrations, configs);
  const configIds = new Set(configs.map((config) => config.id));
  validateDependencyTargets(registrations, configIds);
  validatePlans(Reflect.get(definition, "plans"), registrations, configIds);
}

function clonePosition(position: GeneratedSourcePosition): GeneratedSourcePosition {
  return Object.freeze({
    offset: position.offset,
    line: position.line,
    character: position.character,
  });
}

function cloneSource(source: GeneratedSourceReference): GeneratedSourceReference {
  return Object.freeze({
    file: source.file,
    start: clonePosition(source.start),
    end: clonePosition(source.end),
  });
}

function cloneDependency(dependency: GeneratedDependency): GeneratedDependency {
  if (dependency.mode === "collection") {
    return Object.freeze({
      parameterIndex: dependency.parameterIndex,
      mode: "collection",
      members: Object.freeze(
        dependency.members.map((member) =>
          Object.freeze({ targetId: member.targetId, mode: member.mode }),
        ),
      ),
      source: cloneSource(dependency.source),
    });
  }
  return Object.freeze({
    parameterIndex: dependency.parameterIndex,
    targetId: dependency.targetId,
    mode: dependency.mode,
    source: cloneSource(dependency.source),
  });
}

function cloneClassRegistration<T extends object, THook extends object>(
  registration: GeneratedClassRegistration<T, THook>,
): GeneratedClassRegistration<T, THook> {
  return Object.freeze({
    kind: "class",
    id: registration.id,
    source: cloneSource(registration.source),
    scope: registration.scope,
    target: registration.target,
    dependencies: Object.freeze(registration.dependencies.map(cloneDependency)),
    create: registration.create,
    hooks: Object.freeze({
      start: registration.hooks.start,
      close: registration.hooks.close,
    }),
  });
}

function cloneFactoryRegistration<T extends object, TDispose extends object>(
  registration: GeneratedFactoryRegistration<T, TDispose>,
): GeneratedFactoryRegistration<T, TDispose> {
  const common = {
    kind: "factory" as const,
    id: registration.id,
    source: cloneSource(registration.source),
    scope: registration.scope,
    definition: registration.definition,
    dependencies: [] as const,
    create: registration.create,
  };
  if (!registration.dispose) {
    return Object.freeze(common);
  }
  return Object.freeze({ ...common, dispose: registration.dispose });
}

function cloneRegistration(registration: GeneratedBeanRegistration): GeneratedBeanRegistration {
  if (registration.kind === "class") {
    return cloneClassRegistration(registration);
  }
  return cloneFactoryRegistration(registration);
}

function cloneConfigRegistration<T extends object>(
  registration: GeneratedConfigRegistration<T>,
): GeneratedConfigRegistration<T> {
  return Object.freeze({
    kind: "config",
    id: registration.id,
    source: cloneSource(registration.source),
    target: registration.target,
  });
}

export function snapshotConfigRegistration<T extends object>(
  registration: GeneratedConfigRegistration<T>,
): GeneratedConfigRegistration<T> {
  const candidate: unknown = registration;
  validateConfigRegistrationLocal(candidate);
  return cloneConfigRegistration(registration);
}

export function snapshotClassRegistration<T extends object>(
  registration: GeneratedClassRegistration<T>,
): GeneratedClassRegistration<T> {
  const candidate: unknown = registration;
  validateClassRegistrationLocal(candidate);
  return cloneClassRegistration(registration);
}

export function snapshotFactoryRegistration<T extends object>(
  registration: GeneratedFactoryRegistration<T>,
): GeneratedFactoryRegistration<T> {
  const candidate: unknown = registration;
  validateFactoryRegistrationLocal(candidate);
  return cloneFactoryRegistration(registration);
}

export function snapshotApplicationDefinition(
  definition: GeneratedApplicationDefinition,
): GeneratedApplicationDefinition {
  validateApplicationDefinition(definition);
  return Object.freeze({
    schemaVersion: 6 as const,
    configs: Object.freeze(definition.configs.map(cloneConfigRegistration)),
    // The binding is carried by reference: it is behavior, not data, and the bind contract
    // is per-call stateless, so a clone could only obscure its identity.
    ...(definition.configBinding ? { configBinding: definition.configBinding } : {}),
    registrations: Object.freeze(definition.registrations.map(cloneRegistration)),
    plans: Object.freeze({
      constructionOrder: Object.freeze([...definition.plans.constructionOrder]),
      requestConstructionOrder: Object.freeze([...definition.plans.requestConstructionOrder]),
      startActionOrder: Object.freeze([...definition.plans.startActionOrder]),
      cleanupActionOrder: Object.freeze([...definition.plans.cleanupActionOrder]),
    }),
  });
}
