import { type Current, Injectable } from "@reforce/context";
import { Controller, Get, Post, type RequestContext } from "@reforce/web";
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

@Injectable()
@Controller("/users")
export class UsersController {
  @Get("/:id", { params: snowflakeParamsSchema, response: userResponseSchema })
  @Roles(["admin"])
  show(context: RequestContext): { id: bigint; name: string } {
    const { id } = context.params as { id: bigint }; // params 形状由路由的 params schema 钉死
    return { id, name: `user-${id}` };
  }

  @Post("", { body: createUserBodySchema, response: profileResponseSchema })
  create(context: RequestContext): { id: string; name: string; secret: string } {
    const { name } = context.body as { name: string }; // body 形状由路由的 body schema 钉死
    // secret 字段故意返回：响应白名单必须把它挡在线上形状之外。
    return { id: "created", name, secret: "do-not-leak" };
  }
}

@Injectable()
@Controller("/audit")
export class AuditController {
  constructor(private readonly audit: Current<RequestAudit>) {}

  @Get("", { query: auditQuerySchema, response: auditResponseSchema })
  async show(context: RequestContext): Promise<{ id: string; path: string }> {
    const { delay } = context.query as { delay: number }; // query 形状由路由的 query schema 钉死
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    const audit = this.audit.get();
    return { id: audit.requestId, path: audit.matchedPath };
  }
}

@Injectable()
@Controller("/health")
export class HealthController {
  @Get()
  probe(): Response {
    return new Response("ok");
  }
}

@Injectable()
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
