import {
  interceptPhaseOrder,
  type MethodMetaValueModel,
  type WeavingModel,
} from "@/analysis/interception-model";
import type { GeneratedFile } from "@/api";
import { json } from "@/emission/render";

// 织入表生成物（ADR 0008 AM1，#202 定案 4）：可 diff 的纯数据面，消费者是 code review 与
// AM2 的 explain——运行时不读它（运行时载体是 beans.ts 里的 $Woven），与 manifest.json 定位
// 同族。无标记的应用输出空表：生成物文件集是无条件全集的既有纪律。

interface WeavingTableChainEntry {
  readonly beanId: string;
  readonly phase: string;
  readonly order: number;
  readonly marker: string;
}

interface WeavingTableMethod {
  readonly method: string;
  readonly markers: Record<string, MethodMetaValueModel>;
  readonly chain: readonly WeavingTableChainEntry[];
}

interface WeavingTableBean {
  readonly beanId: string;
  readonly methods: readonly WeavingTableMethod[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMetaValue(value: unknown): value is MethodMetaValueModel {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isMetaValue);
  }
  return isRecord(value) && Object.values(value).every(isMetaValue);
}

function isChainEntry(value: unknown): value is WeavingTableChainEntry {
  return (
    isRecord(value) &&
    typeof value.beanId === "string" &&
    typeof value.phase === "string" &&
    (interceptPhaseOrder as readonly string[]).includes(value.phase) &&
    typeof value.order === "number" &&
    Number.isInteger(value.order) &&
    typeof value.marker === "string"
  );
}

function isTableMethod(value: unknown): value is WeavingTableMethod {
  return (
    isRecord(value) &&
    typeof value.method === "string" &&
    isRecord(value.markers) &&
    Object.values(value.markers).every(isMetaValue) &&
    Array.isArray(value.chain) &&
    value.chain.every(isChainEntry)
  );
}

function isTableBean(value: unknown): value is WeavingTableBean {
  return (
    isRecord(value) &&
    typeof value.beanId === "string" &&
    Array.isArray(value.methods) &&
    value.methods.every(isTableMethod)
  );
}

// 产出前 round-trip 自检（library/meta.ts 同款纪律）：validator 只在这里消费，不导出。
function validateWeavingTable(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return "table is not an object";
  }
  if (value.schemaVersion !== 1) {
    return "unsupported schemaVersion";
  }
  if (!Array.isArray(value.beans) || !value.beans.every(isTableBean)) {
    return "beans do not match the weaving table schema";
  }
  return undefined;
}

export function generateWeavingFile(weaving: WeavingModel): GeneratedFile {
  const beans: readonly WeavingTableBean[] = weaving.beans.map((bean) => ({
    beanId: bean.beanId,
    methods: bean.methods.map((method) => ({
      method: method.method,
      // 0 参标记记 null（JSON 无 undefined）；对象键序由稳定序列化统一排序。
      markers: Object.fromEntries(method.markers),
      // parameterIndex 不进织入表：resolver 槽位是 beans.ts/manifest 依赖边的事实，表里
      // 只回答"被谁包、为什么"（#202 定案 4 的 schema 即闭集）。
      chain: method.chain.map((entry) => ({
        beanId: entry.beanId,
        phase: entry.phase,
        order: entry.order,
        marker: entry.markerKey,
      })),
    })),
  }));
  const content = `${json({ schemaVersion: 1, beans })}\n`;
  const reason = validateWeavingTable(JSON.parse(content));
  if (reason !== undefined) {
    throw new Error(`weaving.json failed its own schema gate: ${reason}`);
  }
  return { path: "weaving.json", content };
}
