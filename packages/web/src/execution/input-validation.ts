import type { StandardSchemaV1 } from "@standard-schema/spec";
import { type RequestInputSource, RequestValidationError } from "@/errors";
import type { RequestContextState } from "@/execution/request-context";
import type { RouteSchemas } from "@/routing/vocabulary";

// 入参校验（ADR 0006 W5）：转换即校验的一部分——validate 的产物（含 codec decode）直接
// 替换 RequestContext 上的对应输入。执行位置钉死在全部中间件之后、handler 之前：admission
// 中间件因此可以在 reforce 解析请求体之前短路。
//
// "之前"的含义按引擎而定，不要读成"没读 socket"：web-node 把请求流原样交给标准 Request，
// 短路确实等于一字节 body 都没读；而 fastify 一定先读完 body 才进 handler，那里短路只省掉
// reforce 这一侧的解析与校验。要在传输层就挡住（解压炸弹一类），用引擎生态在 body 解析前
// 的钩子（@fastify/rate-limit 等），那不是洋葱这一层能表达的。

async function validateInput(
  schema: StandardSchemaV1,
  source: RequestInputSource,
  value: unknown,
): Promise<unknown> {
  const result = await schema["~standard"].validate(value);
  if (result.issues !== undefined) {
    throw new RequestValidationError({ source, issues: result.issues });
  }
  return result.value;
}

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch (cause) {
    throw new RequestValidationError({
      source: "body",
      issues: [{ message: `Request body is not valid JSON: ${String(cause)}` }],
    });
  }
}

// 全局别名 FormDataEntryValue 只在 DOM lib 里，本包不引 DOM；从 getAll 的返回类型取同一个联合
type FormValue = ReturnType<FormData["getAll"]>[number];

// FormData → 普通对象，喂给 schema。规则钉死两条：
// - 同名多值收成数组，单值不包数组（多选 checkbox 是表单里最常见的多值场景）；
// - File 原样保留，交给 schema 自己判定（大小、类型都是 schema 的事）。
//
// 这里与 query 的 snapshotQuery 不一致，且是有意的：那边是 Object.fromEntries(searchParams)，
// 同名参数后值覆盖（`?a=1&a=2` → `{a:"2"}`）。不跟随的理由——query 快照形态是既有契约，改它
// 是 breaking；body 是新增分支，可以直接选正确语义。这条差异别当 bug 去"修统一"。
//
// 用 Object.fromEntries 而不是逐 key 赋值：后者遇到名为 `__proto__` 的表单字段会命中原型
// setter 静默丢值，前者走 CreateDataProperty，没有这个坑。
function formDataToRecord(form: FormData): Record<string, FormValue | FormValue[]> {
  return Object.fromEntries(
    [...new Set(form.keys())].map((name) => {
      const values = form.getAll(name);
      const [only] = values;
      return [name, values.length === 1 && only !== undefined ? only : values] as const;
    }),
  );
}

async function readFormBody(request: Request): Promise<unknown> {
  try {
    return formDataToRecord(await request.formData());
  } catch (cause) {
    // 坏 boundary 一类的解析故障抛的是普通 TypeError，这里换成与 JSON 分支同一个出口
    throw new RequestValidationError({
      source: "body",
      issues: [{ message: `Request body is not a valid form payload: ${String(cause)}` }],
    });
  }
}

// 按 content-type 分派读取方式（#232）。补的是 #220 留下的类型/运行时落差：RequestContext<S>.body 的类型是
// InferSchemaOutput<S["body"]>，已经承诺"拿到的是 schema 的输出"，而此前这里硬编码
// request.json() 不看 content-type——表单与上传路由因此只能不声明 body schema、在 handler
// 里自己 await request.formData()，绕过整个校验与 VO 转换层。
//
// 无 content-type 头与 text/* 也走 json，这条不是随手加的，是防行为回归：这两类 body 今天
// 都能被 request.json() 解析成功，只归 json 一种的话它们会从 200 变 400。最常见的手滑写法
// `fetch(url, { method: "POST", body: JSON.stringify(x) })` 不显式设头时，undici 自动打的
// 正是 text/plain;charset=UTF-8。
async function readBody(request: Request): Promise<unknown> {
  const mediaType = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (mediaType === "multipart/form-data" || mediaType === "application/x-www-form-urlencoded") {
    return await readFormBody(request);
  }
  if (
    mediaType === undefined ||
    mediaType === "" ||
    mediaType === "application/json" ||
    mediaType.endsWith("+json") ||
    mediaType.startsWith("text/")
  ) {
    return await readJsonBody(request);
  }
  throw new RequestValidationError({
    source: "body",
    issues: [{ message: `Unsupported request body content type: ${mediaType}` }],
  });
}

export type RequestInputValidator = (context: RequestContextState) => Promise<void>;

// 校验器按路由在启动时装配一次；未声明 schema 的输入位不做任何工作（body 连流都不读）。
export function createRequestInputValidator(schemas: RouteSchemas): RequestInputValidator {
  const steps: ((context: RequestContextState) => Promise<void>)[] = [];
  const params = schemas.params;
  if (params !== undefined) {
    steps.push(async (context) => {
      context.applyValidated("params", await validateInput(params, "params", context.params));
    });
  }
  const query = schemas.query;
  if (query !== undefined) {
    steps.push(async (context) => {
      context.applyValidated("query", await validateInput(query, "query", context.query));
    });
  }
  const body = schemas.body;
  if (body !== undefined) {
    steps.push(async (context) => {
      const raw = await readBody(context.request);
      context.applyValidated("body", await validateInput(body, "body", raw));
    });
  }
  return async (context) => {
    for (const step of steps) {
      await step(context);
    }
  };
}
