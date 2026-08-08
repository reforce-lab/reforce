import {
  DEPENDENCY_VERSIONS,
  DEV_DEPENDENCY_VERSIONS,
  REFORCE_VERSION,
} from "@/dependency-versions";
import { ENGINES, type EngineKey } from "@/engines";

export interface ProjectSpec {
  readonly name: string;
  readonly engine: EngineKey;
  readonly lint: boolean;
}

function sortByKey(entries: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)));
}

// @reforce/web-<engine> 把 hono / fastify 放在自己的 dependencies 里，生成的应用不直接
// import 它们，所以这里只声明引擎适配器本身。
function createDependencies(engine: EngineKey): Record<string, string> {
  return sortByKey({
    "@reforce/config": REFORCE_VERSION,
    "@reforce/core": REFORCE_VERSION,
    "@reforce/logging": REFORCE_VERSION,
    "@reforce/web-core": REFORCE_VERSION,
    [ENGINES[engine].packageName]: REFORCE_VERSION,
    zod: DEPENDENCY_VERSIONS.zod,
  });
}

function createDevDependencies(lint: boolean): Record<string, string> {
  return sortByKey({
    "@reforce/cli": REFORCE_VERSION,
    "@types/node": DEV_DEPENDENCY_VERSIONS["@types/node"],
    typescript: DEV_DEPENDENCY_VERSIONS.typescript,
    ...(lint ? { "@biomejs/biome": DEV_DEPENDENCY_VERSIONS["@biomejs/biome"] } : {}),
  });
}

function createScripts(lint: boolean): Record<string, string> {
  return {
    dev: "reforce dev",
    build: "reforce build",
    start: "reforce start",
    typecheck: "tsc",
    ...(lint ? { check: "biome check .", "check:write": "biome check --write ." } : {}),
  };
}

export function createPackageJson(spec: ProjectSpec): Record<string, unknown> {
  return {
    name: spec.name,
    version: "0.1.0",
    // 应用不是要发布的库，private 挡住手滑的 npm publish。
    private: true,
    type: "module",
    engines: { node: ">=24" },
    scripts: createScripts(spec.lint),
    dependencies: createDependencies(spec.engine),
    devDependencies: createDevDependencies(spec.lint),
  };
}

export function renderPackageJson(spec: ProjectSpec): string {
  return `${JSON.stringify(createPackageJson(spec), undefined, 2)}\n`;
}
