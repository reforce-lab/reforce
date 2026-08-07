import type { Current } from "@reforce/core";
import type { Logger } from "@reforce/logging";
import { Controller, defineHttpError, Get, Post, type RequestContext } from "@reforce/web";
import type { RequestAudit } from "@/http-exchange";
import { Roles } from "@/web-markers";
import {
  auditQuerySchema,
  auditResponseSchema,
  createUserBodySchema,
  profileResponseSchema,
  snowflakeParamsSchema,
  userResponseSchema,
} from "@/web-schemas";

// handler 参数必须显式标注：TS 不给类方法参数做上下文类型化。类型本身来自装饰器里的
// schema——把同一组 schema 提成顶层 const，标注写 RequestContext<typeof X> 即可，
// 装饰器签名负责校验标注与传入的 schemas 一致（ADR 0006 W5）。
const showSchemas = {
  params: snowflakeParamsSchema,
  response: userResponseSchema,
} as const;

const createSchemas = {
  body: createUserBodySchema,
  response: profileResponseSchema,
} as const;

@Controller("/users")
export class UsersController {
  @Get("/:id", showSchemas)
  @Roles(["admin"])
  show(context: RequestContext<typeof showSchemas>): { id: bigint; name: string } {
    const { id } = context.params;
    return { id, name: `user-${id}` };
  }

  @Post("", createSchemas)
  create(context: RequestContext<typeof createSchemas>): {
    id: string;
    name: string;
    secret: string;
  } {
    const { name } = context.body;
    // secret 字段故意返回：响应白名单必须把它挡在线上形状之外。
    return { id: "created", name, secret: "do-not-leak" };
  }
}

const auditSchemas = {
  query: auditQuerySchema,
  response: auditResponseSchema,
} as const;

@Controller("/audit")
export class AuditController {
  constructor(private readonly audit: Current<RequestAudit>) {}

  @Get("", auditSchemas)
  async show(context: RequestContext<typeof auditSchemas>): Promise<{ id: string; path: string }> {
    const { delay } = context.query;
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    const audit = this.audit.get();
    return { id: audit.requestId, path: audit.matchedPath };
  }
}

@Controller("/health")
export class HealthController {
  @Get()
  probe(): Response {
    return new Response("ok");
  }
}

// L4（RFC 0011，#242）：请求期间应用自己打的日志要带上是哪个请求触发的。这个 handler 存在
// 的唯一目的是让 e2e 拿到一条**应用**日志（不是框架发的请求日志），断言它自带 method 与
// path——那些字段没有一个是这里传的，全部由注册进 LoggerFactory 的 LogFieldSource 贡献。
@Controller("/field-source")
export class FieldSourceController {
  constructor(private readonly log: Logger) {}

  @Get()
  probe(): Response {
    this.log.info({ probe: "field-source" }, "handler ran");
    return new Response("ok");
  }
}

// 用户异常原语（ADR 0013 决议 6，#294）：码与状态码写在定义处，抛的时候只填参数。
// 用户起的码不带框架前缀——那个命名空间是用户的。
const GreetingAlreadyExists = defineHttpError<[name: string]>(
  "GREETING_ALREADY_EXISTS",
  "greeting %s already exists",
  409,
);

@Controller("/boom")
export class BoomController {
  @Get("/teapot")
  teapot(): Response {
    throw new Error("boom");
  }

  @Get("/unhandled")
  unhandled(): Response {
    throw new Error("nobody-knows-this-one");
  }

  // 不写任何 @ErrorHandler：HttpError 由 error-dispatch 内置识别，直接成为 409 problem+json。
  @Get("/conflict")
  conflict(): Response {
    throw new GreetingAlreadyExists(["Lynch"]);
  }
}
