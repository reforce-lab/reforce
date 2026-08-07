import type { StandardSchemaV1 } from "@standard-schema/spec";
import { type RequestInputSource, RequestValidationError } from "@/errors";
import type { RequestContextState } from "@/execution/request-context";
import type { GeneratedRouteSlot } from "@/generated/route-table";

// 槽位执行链(RFC 0012 S2,#274):启动期按路由表的 slots 装配一次,热路径零决策。执行位置
// 沿用旧校验层的钉死约定(ADR 0006 W5):全部中间件之后、handler 之前——admission 中间件仍可
// 在 reforce 读请求体之前短路。
//
// 每槽输入载体按契约来源分派(#274 载体表):生成解码器(decode)吃原生载体——param 是路径
// 参数 record、query 是 URLSearchParams(getAll 语义)、header 是原生 Headers(大小写不敏感
// 由它承担);用户 schema 吃 plain object 快照(zod 一类不认 URLSearchParams/Headers)。
// body 双方同吃严格读体产物。裸标注槽(request/requestContext/responseHeaders)不产出槽值,
// 生成的 invoke 直接从 context 取。

// 严格读体(层①):content-type 只认 application/json(容忍 charset 等参数,不认 +json 与
// 表单——表单/上传路由自己 await request.formData(),不占 Body 槽);空体与坏 JSON 各自给
// 明确文案。比旧链路的按 content-type 分派严格是有意的:Body 槽位的契约就是 JSON,放行
// text/* 只会把"忘设头"的调用方推迟到字段校验才失败,文案反而更难懂。
async function readJsonBody(request: Request): Promise<unknown> {
  const reject = (message: string): never => {
    throw new RequestValidationError({ source: "body", issues: [{ message }] });
  };
  const mediaType = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    reject("content-type must be application/json");
  }
  const text = await request.text();
  if (text.length === 0) {
    reject("request body is empty");
  }
  try {
    return JSON.parse(text);
  } catch (cause) {
    return reject(`request body is not valid JSON: ${String(cause)}`);
  }
}

// GeneratedSlotKind 与 RequestInputSource 的词形差异只有 param/params,表驱动钉死映射。
const sourceBySlot = {
  param: "params",
  query: "query",
  header: "header",
  body: "body",
} as const satisfies Record<string, RequestInputSource>;

type DataSlotKind = keyof typeof sourceBySlot;

function isDataSlot(slot: GeneratedRouteSlot): slot is GeneratedRouteSlot & {
  readonly slot: DataSlotKind;
} {
  return slot.slot in sourceBySlot;
}

type ReadBody = () => Promise<unknown>;

type CarrierOf = (context: RequestContextState, readBody: ReadBody) => unknown;

// 生成解码器的载体:原生对象直通。
const decodeCarriers: Record<DataSlotKind, CarrierOf> = {
  param: (context) => context.params,
  query: (context) => context.url.searchParams,
  header: (context) => context.request.headers,
  body: (_context, readBody) => readBody(),
};

// 用户 schema 的载体:plain object 快照。header 键经 Headers 迭代天然小写化。
const schemaCarriers: Record<DataSlotKind, CarrierOf> = {
  param: (context) => context.params,
  query: (context) => context.query,
  header: (context) => Object.fromEntries(context.request.headers),
  body: (_context, readBody) => readBody(),
};

interface SlotStep {
  /** handler 参数序下标:槽值必须落在自己的位置上,裸槽位置留空。 */
  readonly index: number;
  readonly source: RequestInputSource;
  readonly carrierOf: CarrierOf;
  readonly validate: StandardSchemaV1;
}

interface SlotFailure {
  readonly source: RequestInputSource;
  readonly issues: readonly StandardSchemaV1.Issue[];
}

async function runStep(
  step: SlotStep,
  context: RequestContextState,
  readBody: ReadBody,
  values: unknown[],
  failures: SlotFailure[],
): Promise<void> {
  let result: StandardSchemaV1.Result<unknown>;
  try {
    result = await step.validate["~standard"].validate(await step.carrierOf(context, readBody));
  } catch (error) {
    // 层①的读体失败归为本槽的校验失败,与解码 issues 走同一收齐出口;schema 自身抛出的
    // 其他错误是实现故障,按 500 上抛。
    if (error instanceof RequestValidationError) {
      failures.push({ source: error.source, issues: error.issues });
      return;
    }
    throw error;
  }
  if (result.issues !== undefined) {
    failures.push({ source: step.source, issues: result.issues });
    return;
  }
  values[step.index] = result.value;
}

export type SlotExecutor = (context: RequestContextState) => Promise<readonly unknown[]>;

// 跨槽位收齐 issues 一次 400:一个请求把所有槽的错误一次拿全,比逐槽首错快速失败少一轮
// 往返;source 取首错槽(RequestValidationError 的 source 是单值,PR 描述已写明此推断口径)。
export function createSlotExecutor(slots: readonly GeneratedRouteSlot[]): SlotExecutor {
  const steps: SlotStep[] = [];
  for (const [index, slot] of slots.entries()) {
    if (!isDataSlot(slot)) {
      continue;
    }
    const validate = slot.decode ?? slot.schema;
    if (validate === undefined) {
      continue;
    }
    const carriers = slot.decode !== undefined ? decodeCarriers : schemaCarriers;
    steps.push({
      index,
      source: sourceBySlot[slot.slot],
      carrierOf: carriers[slot.slot],
      validate,
    });
  }
  return async (context) => {
    const values: unknown[] = new Array(slots.length);
    if (steps.length === 0) {
      return values;
    }
    // 读体至多一次:同一请求的多个 Body 槽共享同一份读体结果(流只能消费一次)。
    let bodyOnce: Promise<unknown> | undefined;
    const readBody: ReadBody = () => {
      bodyOnce ??= readJsonBody(context.request);
      return bodyOnce;
    };
    const failures: SlotFailure[] = [];
    for (const step of steps) {
      await runStep(step, context, readBody, values, failures);
    }
    const first = failures[0];
    if (first !== undefined) {
      throw new RequestValidationError({
        source: first.source,
        issues: failures.flatMap((failure) => failure.issues),
      });
    }
    return values;
  };
}
