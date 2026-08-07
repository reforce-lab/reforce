import type { Current } from "@reforce/core";
import type { Logger } from "@reforce/logging";
import { type Body, Controller, Get, type Param, Post, type Query } from "@reforce/web";
import type { RequestAudit } from "@/http-exchange";
import { Roles } from "@/web-markers";
import type { CreateUserBody, SnowflakeParams } from "@/web-schemas";

// 槽位写法(RFC 0012 S2,#274):输入契约由 handler 参数的类型标注表达,响应契约由返回类型
// 标注表达。SnowflakeParams/CreateUserBody 经 typeof 追溯到 web-schemas 的 Standard Schema,
// 解码交给 schema(codec 语义保留);Query 单键与全部响应由编译器按类型生成解码器/编码器。

@Controller("/users")
export class UsersController {
  // 第四档投影:解码按整个 SnowflakeParams 契约跑,参数值按 "id" 键取,handler 直接拿 bigint。
  @Get("/:id")
  @Roles(["admin"])
  show(id: Param<SnowflakeParams, "id">): { id: bigint; name: string } {
    return { id, name: `user-${id}` };
  }

  @Post()
  create(name: Body<CreateUserBody, "name">): { id: string; name: string } {
    // secret 字段故意返回：返回类型契约的白名单必须把它挡在线上形状之外。
    // 非字面量返回绕开 excess property check,正是"映射漏删的实体字段"的真实形态。
    const entity = { id: "created", name, secret: "do-not-leak" };
    return entity;
  }
}

@Controller("/audit")
export class AuditController {
  constructor(private readonly audit: Current<RequestAudit>) {}

  // 可选单键:线上 string → number 由生成解码器完成,缺省语义在 handler 里落 0。
  @Get()
  async show(delay: Query<"delay", number | undefined>): Promise<{ id: string; path: string }> {
    if (delay !== undefined && delay > 0) {
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
}
