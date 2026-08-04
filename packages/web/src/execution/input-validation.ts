import type { StandardSchemaV1 } from "@standard-schema/spec";
import { type RequestInputSource, RequestValidationError } from "@/errors";
import type { RequestContextState } from "@/execution/request-context";
import type { RouteSchemas } from "@/routing/vocabulary";

// 入参校验（ADR 0006 W5）：转换即校验的一部分——validate 的产物（含 codec decode）直接
// 替换 RequestContext 上的对应输入。执行位置钉死在全部中间件之后、handler 之前：admission
// 中间件因此可以在解析请求体之前短路。

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
      const raw = await readJsonBody(context.request);
      context.applyValidated("body", await validateInput(body, "body", raw));
    });
  }
  return async (context) => {
    for (const step of steps) {
      await step(context);
    }
  };
}
