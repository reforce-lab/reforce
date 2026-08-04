import type { ConfigBindingIssue } from "@reforce/context";
import type {
  GeneratedConfigBinding,
  GeneratedConfigBindingOutcome,
  GeneratedConfigRegistration,
} from "@reforce/context/generated-runtime";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { type EnvironmentSnapshot, loadEnvironmentSnapshot } from "@/binding/env-layers";
import {
  buildBindingInput,
  environmentVariableName,
  expandKeyPaths,
  prefixWordsOf,
  suggestEnvironmentName,
} from "@/binding/key-mapping";
import { readConfigPropertiesMetadata } from "@/config-properties";

export interface CreateConfigBindingOptions {
  readonly root?: string;
}

function normalizeKeyPath(path: StandardSchemaV1.Issue["path"]): readonly (string | number)[] {
  if (path === undefined) {
    return [];
  }
  return path.map((segment) => {
    const key = typeof segment === "object" ? segment.key : segment;
    return typeof key === "number" ? key : String(key);
  });
}

// ConfigBindingIssue 永不携带配置值（ADR 0005 决策 6.2）：reason 只转述 schema 文案
function toBindingIssue(
  configId: string,
  prefix: string,
  issue: StandardSchemaV1.Issue,
  snapshot: EnvironmentSnapshot,
): ConfigBindingIssue {
  const keyPath = normalizeKeyPath(issue.path);
  const environmentVariable = environmentVariableName(prefix, keyPath);
  return {
    configId,
    keyPath,
    environmentVariable,
    layer: snapshot.provenance.get(environmentVariable) ?? "unset",
    reason: issue.message,
  };
}

function candidatePathExists(output: object, path: readonly string[]): boolean {
  let node: unknown = output;
  for (const segment of path) {
    if (typeof node !== "object" || node === null || !Object.hasOwn(node, segment)) {
      return false;
    }
    node = Reflect.get(node, segment);
  }
  return true;
}

function collectLeafEnvironmentNames(
  prefix: string,
  node: object,
  path: (string | number)[],
  names: string[],
): void {
  for (const [key, value] of Object.entries(node)) {
    const index = Array.isArray(node) ? Number(key) : key;
    path.push(index);
    if (typeof value === "object" && value !== null) {
      collectLeafEnvironmentNames(prefix, value, path, names);
    } else {
      names.push(environmentVariableName(prefix, path));
    }
    path.pop();
  }
}

// 绑定成功后的 typo 保护（ADR 0005 决策 6.3）：只告警，不影响结果
function warnUnmatchedKeys(
  configId: string,
  prefix: string,
  output: object,
  snapshot: EnvironmentSnapshot,
): void {
  const keyPrefix = `${prefixWordsOf(prefix).join("_").toUpperCase()}_`;
  const knownNames: string[] = [];
  collectLeafEnvironmentNames(prefix, output, [], knownNames);
  for (const key of [...snapshot.values.keys()].sort()) {
    if (!key.startsWith(keyPrefix)) {
      continue;
    }
    const segments = key
      .slice(keyPrefix.length)
      .split("_")
      .map((segment) => segment.toLowerCase());
    const candidates = expandKeyPaths(segments);
    if (candidates.some((candidate) => candidatePathExists(output, candidate))) {
      continue;
    }
    const suggestion = suggestEnvironmentName(key, knownNames);
    const hint = suggestion === undefined ? "" : `; did you mean ${suggestion}?`;
    console.warn(`[reforce.config] ${key} does not match any bound property of ${configId}${hint}`);
  }
}

interface ValidatedConfig {
  readonly registration: GeneratedConfigRegistration;
  readonly prefix: string;
  readonly output: object;
}

type RegistrationResult =
  | { readonly issues: readonly ConfigBindingIssue[] }
  | { readonly config: ValidatedConfig };

async function validateRegistration(
  registration: GeneratedConfigRegistration,
  snapshot: EnvironmentSnapshot,
): Promise<RegistrationResult> {
  const metadata = readConfigPropertiesMetadata(registration.target);
  if (metadata === undefined) {
    // 编译器保证 config 类都继承 ConfigProperties；这里只是防御坏的生成产物
    throw new TypeError(
      `Config "${registration.id}" does not extend a ConfigProperties(...) base class.`,
    );
  }
  const input = buildBindingInput(prefixWordsOf(metadata.prefix), snapshot.values);
  const result = await metadata.schema["~standard"].validate(input);
  if (result.issues !== undefined) {
    return {
      issues: result.issues.map((issue) =>
        toBindingIssue(registration.id, metadata.prefix, issue, snapshot),
      ),
    };
  }
  if (typeof result.value !== "object" || result.value === null) {
    // ConfigProperties 的类型约束要求 schema 输出 object；运行期拿到非对象
    // 说明 schema 声明被绕过，属编程错误而非环境配置问题
    throw new TypeError(`Config "${registration.id}" schema produced a non-object output.`);
  }
  return { config: { registration, prefix: metadata.prefix, output: result.value } };
}

function instantiateConfigs(
  validated: readonly ValidatedConfig[],
  snapshot: EnvironmentSnapshot,
): ReadonlyMap<string, object> {
  const instances = new Map<string, object>();
  for (const { registration, prefix, output } of validated) {
    // BeanClass 是 abstract new (...args: never[])，运行期 target 实际是用户的
    // ConfigProperties 子类，其构造器接收完整 schema 输出；类型系统无法关联两者
    const target = registration.target as new (values: object) => object;
    instances.set(registration.id, new target(output));
    warnUnmatchedKeys(registration.id, prefix, output, snapshot);
  }
  return instances;
}

export function createConfigBinding(
  options: CreateConfigBindingOptions = {},
): GeneratedConfigBinding {
  return {
    async bind(
      configs: readonly GeneratedConfigRegistration[],
    ): Promise<GeneratedConfigBindingOutcome> {
      const snapshot = loadEnvironmentSnapshot({
        root: options.root ?? process.cwd(),
        env: process.env,
        bunAutoLoaded: typeof process.versions.bun === "string",
      });
      for (const warning of snapshot.warnings) {
        console.warn(`[reforce.config] ${warning}`);
      }

      // 不在第一个失败的 config 停下：跨 config 聚合全部 issue（ADR 0005 决策 6.1）
      const issues: ConfigBindingIssue[] = [];
      const validated: ValidatedConfig[] = [];
      for (const registration of configs) {
        const result = await validateRegistration(registration, snapshot);
        if ("issues" in result) {
          issues.push(...result.issues);
          continue;
        }
        validated.push(result.config);
      }
      if (issues.length > 0) {
        return { status: "failed", issues };
      }
      return { status: "bound", instances: instantiateConfigs(validated, snapshot) };
    },
  };
}
