import { describe, expect, test } from "vitest";
import type { RequestContext } from "@/execution/request-context";
import { Controller, Get, Post } from "@/routing/decorators";

// 路由 schema 的类型接到 handler（ADR 0006 W5）：装饰器捕获 schemas 的具体类型，handler 用
// RequestContext<typeof schemas> 标注就能直接读到校验+decode 之后的形状，不必再 `as` 回来。
// 这些断言由 packages/web 的 typecheck 背书——@ts-expect-error 没被触发时 tsc 反过来报
// "unused directive"（context/it/public-api.spec.ts 同款做法，Issue #106）。
//
// 这里给的是约束不是免标注：TS 不给类方法参数做上下文类型化，handler 参数必须显式标注；
// 装饰器负责校验这个标注与传入的 schemas 一致。

interface SnowflakeParams {
  readonly id: bigint;
}

interface CreateBody {
  readonly name: string;
}

interface UserView {
  readonly id: bigint;
  readonly name: string;
}

// "~standard".types 是纯类型槽位（spec 里 optional、运行时恒为 undefined）：
// InferOutput 只从这里读输出类型。返回类型带 undefined，所以这里不需要断言。
function schemaTypes<Output>(): { readonly input: unknown; readonly output: Output } | undefined {
  return undefined;
}

const paramsSchema = {
  "~standard": {
    version: 1 as const,
    vendor: "reforce-it",
    types: schemaTypes<SnowflakeParams>(),
    // 夹具 schema 不做真实校验，只提供类型槽位 // justified: 见上一行
    validate: (value: unknown) => ({ value: value as SnowflakeParams }),
  },
};

const bodySchema = {
  "~standard": {
    version: 1 as const,
    vendor: "reforce-it",
    types: schemaTypes<CreateBody>(),
    // 夹具 schema 不做真实校验，只提供类型槽位 // justified: 见上一行
    validate: (value: unknown) => ({ value: value as CreateBody }),
  },
};

const responseSchema = {
  "~standard": {
    version: 1 as const,
    vendor: "reforce-it",
    types: schemaTypes<UserView>(),
    // 夹具 schema 不做真实校验，只提供类型槽位 // justified: 见上一行
    validate: (value: unknown) => ({ value: value as UserView }),
  },
};

const showSchemas = { params: paramsSchema, response: responseSchema };
const createSchemas = { body: bodySchema, response: responseSchema };

// 精确相等（不是"可赋值"）：单向可赋值证明不了什么——any 对任何目标都可赋值。
type Exact<Actual, Expected> =
  (<T>() => T extends Actual ? 1 : 2) extends <T>() => T extends Expected ? 1 : 2 ? true : false;

function verifyDeclaredSlotsCarryTheirSchemaOutput(
  context: RequestContext<typeof showSchemas>,
): void {
  const paramsAreExactlyTheSchemaOutput: Exact<typeof context.params, SnowflakeParams> = true;
  const idIsExactlyBigint: Exact<typeof context.params.id, bigint> = true;
  void paramsAreExactlyTheSchemaOutput;
  void idIsExactlyBigint;
}

function verifyUndeclaredSlotsStayUnknown(context: RequestContext<typeof showSchemas>): void {
  // showSchemas 没声明 body/query，两个槽位诚实地留在 unknown。
  // @ts-expect-error An undeclared slot has no shape to read.
  void context.body.anything;
  const body: unknown = context.body;
  void body;
}

function verifyTheBareContextKeepsEveryDataSlotUnknown(context: RequestContext): void {
  // @ts-expect-error Without schemas the context promises nothing about params.
  void context.params.id;
}

void verifyDeclaredSlotsCarryTheirSchemaOutput;
void verifyUndeclaredSlotsStayUnknown;
void verifyTheBareContextKeepsEveryDataSlotUnknown;

function verifyTheDecoratorRejectsAMismatchedAnnotation(): void {
  @Controller("/users")
  class Users {
    // @ts-expect-error The handler annotation must match the schemas passed to @Get.
    @Get("/:id", showSchemas)
    show(context: RequestContext<typeof createSchemas>): UserView {
      void context;
      return { id: 1n, name: "u" };
    }
  }
  void Users;
}

function verifyTheDecoratorPinsTheReturnTypeToTheResponseSchema(): void {
  @Controller("/users")
  class Users {
    // @ts-expect-error The response schema pins the return type; a string is not a UserView.
    @Get("/:id", showSchemas)
    show(context: RequestContext<typeof showSchemas>): string {
      void context;
      return "not a user";
    }
  }
  void Users;
}

void verifyTheDecoratorRejectsAMismatchedAnnotation;
void verifyTheDecoratorPinsTheReturnTypeToTheResponseSchema;

describe("schema typing reaches the handler without a cast", () => {
  test("a handler reads the decoded params straight off the context", () => {
    @Controller("/users")
    class Users {
      @Get("/:id", showSchemas)
      show(context: RequestContext<typeof showSchemas>): UserView {
        const { id } = context.params;
        return { id, name: `user-${id}` };
      }

      // Response 原样透传仍然合法，与 response schema 并存（W5 契约）。
      @Post("", createSchemas)
      create(context: RequestContext<typeof createSchemas>): Response {
        return new Response(context.body.name);
      }
    }

    const users = new Users();
    // handler 只读 params，构造完整的 RequestContext 与本用例无关 // justified: 见上一行
    const context = { params: { id: 7n } } as unknown as RequestContext<typeof showSchemas>;

    expect(users.show(context)).toEqual({ id: 7n, name: "user-7" });
  });
});
