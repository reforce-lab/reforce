import { isObject } from "radashi";
import { hasExactKeys } from "@/project/exact-keys";

// 织入表的信任边界（ADR 0008 AM2，#204 定案 7）：explain 是 weaving.json 的第一个程序消费者，
// 形状镜像生产方 compiler/src/emission/generate-weaving-file.ts——schemaVersion、阶段闭集、
// 链条目字段皆为线上协议，改动任一条都必须与生产方同步。产物可能被手改，逐字段复检。

const interceptPhases = ["observability", "admission", "cache", "transaction", "application"];

export type WeavingMetaValue =
  | string
  | number
  | boolean
  | null
  | readonly WeavingMetaValue[]
  | { readonly [key: string]: WeavingMetaValue };

export interface WeavingChainEntry {
  readonly beanId: string;
  readonly phase: string;
  readonly order: number;
  readonly marker: string;
}

export interface WeavingMethod {
  readonly method: string;
  // 0 参标记记 null（JSON 无 undefined）；键序由生成侧稳定序列化保证。
  readonly markers: Record<string, WeavingMetaValue>;
  readonly chain: readonly WeavingChainEntry[];
}

export interface WeavingBean {
  readonly beanId: string;
  readonly methods: readonly WeavingMethod[];
}

export interface GeneratedWeavingTable {
  readonly schemaVersion: 1;
  readonly beans: readonly WeavingBean[];
}

function isMetaValue(value: unknown): value is WeavingMetaValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    return items.every(isMetaValue);
  }
  return isObject(value) && Object.values(value).every(isMetaValue);
}

function isChainEntry(value: unknown): value is WeavingChainEntry {
  return (
    isObject(value) &&
    hasExactKeys(value, ["beanId", "phase", "order", "marker"]) &&
    typeof Reflect.get(value, "beanId") === "string" &&
    interceptPhases.includes(Reflect.get(value, "phase")) &&
    Number.isInteger(Reflect.get(value, "order")) &&
    typeof Reflect.get(value, "marker") === "string"
  );
}

function isWeavingMethod(value: unknown): value is WeavingMethod {
  if (!isObject(value) || !hasExactKeys(value, ["method", "markers", "chain"])) {
    return false;
  }
  const markers = Reflect.get(value, "markers");
  const chain = Reflect.get(value, "chain");
  return (
    typeof Reflect.get(value, "method") === "string" &&
    isObject(markers) &&
    Object.values(markers).every(isMetaValue) &&
    Array.isArray(chain) &&
    (chain as readonly unknown[]).every(isChainEntry)
  );
}

function isWeavingBean(value: unknown): value is WeavingBean {
  if (!isObject(value) || !hasExactKeys(value, ["beanId", "methods"])) {
    return false;
  }
  const methods = Reflect.get(value, "methods");
  return (
    typeof Reflect.get(value, "beanId") === "string" &&
    Array.isArray(methods) &&
    (methods as readonly unknown[]).every(isWeavingMethod)
  );
}

function isGeneratedWeavingTable(value: unknown): value is GeneratedWeavingTable {
  if (
    !isObject(value) ||
    !hasExactKeys(value, ["schemaVersion", "beans"]) ||
    Reflect.get(value, "schemaVersion") !== 1
  ) {
    return false;
  }
  const beans = Reflect.get(value, "beans");
  return Array.isArray(beans) && (beans as readonly unknown[]).every(isWeavingBean);
}

export function parseGeneratedWeavingBytes(bytes: Uint8Array): GeneratedWeavingTable | undefined {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isGeneratedWeavingTable(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function wovenMethodsOf(
  table: GeneratedWeavingTable,
  beanId: string,
): readonly WeavingMethod[] {
  return table.beans.find((bean) => bean.beanId === beanId)?.methods ?? [];
}
