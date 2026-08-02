import { isObject } from "radashi";
import { InvalidGeneratedDefinitionError } from "@/errors";
import type {
  GeneratedApplicationDefinition,
  GeneratedBeanRegistration,
  GeneratedClassRegistration,
  GeneratedDependency,
  GeneratedExecutionPlans,
  GeneratedFactoryRegistration,
  GeneratedSourcePosition,
  GeneratedSourceReference,
} from "@/generated-contracts";

const dependencyModes = new Set(["eager", "cycle-proxy", "explicit-lazy"]);

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
  if (!Number.isInteger(value) || typeof value !== "number" || value < 0) {
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

export function validateGeneratedBeanId(value: unknown, path: string): string {
  const id = requireString(value, path);
  const separator = id.indexOf("#");
  if (separator <= 0 || separator !== id.lastIndexOf("#") || separator === id.length - 1) {
    return fail(`${path} must contain one non-edge # separator.`);
  }
  validateRelativePosixPath(id.slice(0, separator), `${path} file part`);
  return id;
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

export function validateSourceReference(
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

function validateDependency(
  value: unknown,
  index: number,
  path: string,
): asserts value is GeneratedDependency {
  const dependency = requireObject(value, path);
  requireExactKeys(dependency, ["parameterIndex", "targetId", "mode", "source"], path);
  const parameterIndex = requireNonNegativeInteger(
    Reflect.get(dependency, "parameterIndex"),
    `${path}.parameterIndex`,
  );
  if (parameterIndex !== index) {
    return fail(`${path}.parameterIndex must equal its array index.`);
  }
  validateGeneratedBeanId(Reflect.get(dependency, "targetId"), `${path}.targetId`);
  const mode = Reflect.get(dependency, "mode");
  if (typeof mode !== "string" || !dependencyModes.has(mode)) {
    return fail(`${path}.mode is unknown.`);
  }
  validateSourceReference(Reflect.get(dependency, "source"), `${path}.source`);
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

export function validateClassRegistrationLocal(
  value: unknown,
  path = "class registration",
): asserts value is GeneratedClassRegistration {
  const registration = requireObject(value, path);
  requireExactKeys(
    registration,
    ["kind", "id", "source", "target", "dependencies", "create", "hooks"],
    path,
  );
  if (Reflect.get(registration, "kind") !== "class") {
    return fail(`${path}.kind must be "class".`);
  }
  validateGeneratedBeanId(Reflect.get(registration, "id"), `${path}.id`);
  validateSourceReference(Reflect.get(registration, "source"), `${path}.source`);
  requireFunction(Reflect.get(registration, "target"), `${path}.target`);
  requireFunction(Reflect.get(registration, "create"), `${path}.create`);
  validateDependencies(Reflect.get(registration, "dependencies"), `${path}.dependencies`);
  validateHooks(Reflect.get(registration, "hooks"), `${path}.hooks`);
}

export function validateFactoryRegistrationLocal(
  value: unknown,
  path = "factory registration",
): asserts value is GeneratedFactoryRegistration {
  const registration = requireObject(value, path);
  requireExactKeys(
    registration,
    ["kind", "id", "source", "definition", "dependencies", "create", "dispose"],
    path,
  );
  if (Reflect.get(registration, "kind") !== "factory") {
    return fail(`${path}.kind must be "factory".`);
  }
  validateGeneratedBeanId(Reflect.get(registration, "id"), `${path}.id`);
  validateSourceReference(Reflect.get(registration, "source"), `${path}.source`);
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

function validatePlans(
  value: unknown,
  registrations: readonly GeneratedBeanRegistration[],
): asserts value is GeneratedExecutionPlans {
  const plans = requireObject(value, "plans");
  requireExactKeys(plans, ["constructionOrder", "startActionOrder", "cleanupActionOrder"], "plans");
  const knownIds = new Set(registrations.map((registration) => registration.id));
  const constructionOrder = validatePlanArray(
    Reflect.get(plans, "constructionOrder"),
    "plans.constructionOrder",
    knownIds,
  );
  requireSameSet(constructionOrder, knownIds, "plans.constructionOrder");

  const constructionIndex = new Map(constructionOrder.map((id, index) => [id, index]));
  for (const registration of registrations) {
    const consumerIndex = constructionIndex.get(registration.id);
    if (consumerIndex === undefined) {
      return fail(`plans.constructionOrder omits "${registration.id}".`);
    }
    for (const dependency of registration.dependencies) {
      if (dependency.mode !== "eager") {
        continue;
      }
      const dependencyIndex = constructionIndex.get(dependency.targetId);
      if (dependencyIndex === undefined || dependencyIndex >= consumerIndex) {
        return fail(
          `plans.constructionOrder must place eager dependency "${dependency.targetId}" before "${registration.id}".`,
        );
      }
    }
  }

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
): Set<string> {
  const ids = new Set<string>();
  const portableIds = new Set<string>();
  const classTargets = new Set<object>();
  const factoryDefinitions = new Set<object>();
  for (const registration of registrations) {
    const id = registration.id;
    if (ids.has(id)) {
      fail(`registration ID "${id}" is duplicated.`);
    }
    ids.add(id);
    const portableId = id.toLowerCase();
    if (portableIds.has(portableId)) {
      fail(`registration ID "${id}" has a portable case collision.`);
    }
    portableIds.add(portableId);
    if (registration.kind === "class") {
      if (classTargets.has(registration.target)) {
        fail(`class target for "${id}" is duplicated.`);
      }
      classTargets.add(registration.target);
      continue;
    }
    if (factoryDefinitions.has(registration.definition)) {
      fail(`factory definition for "${id}" is duplicated.`);
    }
    factoryDefinitions.add(registration.definition);
  }
  return ids;
}

function validateDependencyTargets(
  registrations: readonly GeneratedBeanRegistration[],
  ids: ReadonlySet<string>,
): void {
  for (const registration of registrations) {
    for (const dependency of registration.dependencies) {
      if (!ids.has(dependency.targetId)) {
        fail(
          `dependency of "${registration.id}" references unknown Bean "${dependency.targetId}".`,
        );
      }
    }
  }
}

export function validateApplicationDefinition(
  value: unknown,
): asserts value is GeneratedApplicationDefinition {
  const definition = requireObject(value, "definition");
  requireExactKeys(definition, ["schemaVersion", "registrations", "plans"], "definition");
  if (Reflect.get(definition, "schemaVersion") !== 1) {
    return fail("definition.schemaVersion must be 1.");
  }
  const registrationCandidates = requireArray(
    Reflect.get(definition, "registrations"),
    "definition.registrations",
  );
  const registrations: GeneratedBeanRegistration[] = [];
  for (const [index, registration] of registrationCandidates.entries()) {
    validateRegistration(registration, index);
    registrations.push(registration);
  }

  const ids = validateRegistrationIdentities(registrations);
  validateDependencyTargets(registrations, ids);
  validatePlans(Reflect.get(definition, "plans"), registrations);
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
  return Object.freeze({
    parameterIndex: dependency.parameterIndex,
    targetId: dependency.targetId,
    mode: dependency.mode,
    source: cloneSource(dependency.source),
  });
}

function cloneClassRegistration<T extends object>(
  registration: GeneratedClassRegistration<T>,
): GeneratedClassRegistration<T> {
  return Object.freeze({
    kind: "class",
    id: registration.id,
    source: cloneSource(registration.source),
    target: registration.target,
    dependencies: Object.freeze(registration.dependencies.map(cloneDependency)),
    create: registration.create,
    hooks: Object.freeze({
      ...(registration.hooks.start ? { start: registration.hooks.start } : {}),
      ...(registration.hooks.close ? { close: registration.hooks.close } : {}),
    }),
  });
}

function cloneFactoryRegistration<T extends object>(
  registration: GeneratedFactoryRegistration<T>,
): GeneratedFactoryRegistration<T> {
  const common = {
    kind: "factory" as const,
    id: registration.id,
    source: cloneSource(registration.source),
    definition: registration.definition,
    dependencies: [] as const,
    create: registration.create,
  };
  if (!registration.dispose) {
    return Object.freeze(common);
  }
  return Object.freeze({ ...common, dispose: registration.dispose });
}

function cloneErasedClassRegistration(
  registration: Extract<GeneratedBeanRegistration, { readonly kind: "class" }>,
): Extract<GeneratedBeanRegistration, { readonly kind: "class" }> {
  return Object.freeze({
    kind: "class",
    id: registration.id,
    source: cloneSource(registration.source),
    target: registration.target,
    dependencies: Object.freeze(registration.dependencies.map(cloneDependency)),
    create: registration.create,
    hooks: Object.freeze({
      ...(registration.hooks.start ? { start: registration.hooks.start } : {}),
      ...(registration.hooks.close ? { close: registration.hooks.close } : {}),
    }),
  });
}

function cloneErasedFactoryRegistration(
  registration: Extract<GeneratedBeanRegistration, { readonly kind: "factory" }>,
): Extract<GeneratedBeanRegistration, { readonly kind: "factory" }> {
  const common = {
    kind: "factory" as const,
    id: registration.id,
    source: cloneSource(registration.source),
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
    return cloneErasedClassRegistration(registration);
  }
  return cloneErasedFactoryRegistration(registration);
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
  const snapshot = Object.freeze({
    schemaVersion: 1 as const,
    registrations: Object.freeze(definition.registrations.map(cloneRegistration)),
    plans: Object.freeze({
      constructionOrder: Object.freeze([...definition.plans.constructionOrder]),
      startActionOrder: Object.freeze([...definition.plans.startActionOrder]),
      cleanupActionOrder: Object.freeze([...definition.plans.cleanupActionOrder]),
    }),
  });
  return snapshot;
}
