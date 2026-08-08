import type { Current } from "@reforce/core";
import type { Logger } from "@reforce/logging";
import {
  type Body,
  Controller,
  defineHttpError,
  Get,
  type Header,
  type Param,
  Post,
  type Query,
  ResponseSchema,
  ResponseStatus,
  Throws,
} from "@reforce/web-core";
import type { RequestAudit } from "@/http-exchange";
import { OrderRejectedError, QuotaExceededError } from "@/web-errors";
import { Roles } from "@/web-markers";
import { type CreateUserBody, orderWireSchema, type SnowflakeParams } from "@/web-schemas";

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

  // 整契约形态:schema 解码产物即参数值,声明外的多余字段被 schema 输出丢掉——
  // 这条路由把解码产物原样回显,是"多余字段不进 handler"的观察口。
  @Post("/echo")
  echo(body: Body<CreateUserBody>): CreateUserBody {
    return body;
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

// S3 响应侧验收面(RFC 0012 S3,#275):推导/降级/状态码/响应 schema/@Throws/标量坑,
// 一个 controller 集齐。
interface OrderSearchQuery {
  readonly page: number;
  readonly tag?: readonly string[];
}

// 用户自己的 Set-Cookie 组装:框架不提供 cookie API,Headers 槽 + append 即全部所需。
function stringifySetCookie(name: string, value: string): string {
  return `${name}=${value}; Path=/; HttpOnly`;
}

@Controller("/orders")
export class OrdersController {
  // 无标注干净推导:契约由 tsc 推出的返回类型驱动,与显式标注同样白名单(bigint → 字符串)。
  @Get("/inferred")
  inferred() {
    return { id: 7n, name: "inferred" };
  }

  // 无标注且推导失败(经 unknown 的值):降级 free-form,返回值原样序列化出线。
  @Get("/loose")
  loose() {
    const value: unknown = { raw: 1, nested: { keep: true } };
    return value;
  }

  // 单键 Param 写法(与 UsersController 的第四档投影相对)。
  @Get("/:orderId")
  byId(orderId: Param<"orderId", bigint>): { orderId: bigint } {
    return { orderId };
  }

  // Query 整契约形态:page 解码 number,tag 走 getAll 语义。
  @Get("/search")
  search(query: Query<OrderSearchQuery>): { page: number; tags: readonly string[] } {
    return { page: query.page, tags: query.tag ?? [] };
  }

  // 标量坑:空串/0x10/指数、bigint 精度与拒小数、boolean 拒 "1"。
  @Get("/scalars")
  scalars(
    page: Query<"page", number | undefined>,
    big: Query<"big", bigint | undefined>,
    flag: Query<"flag", boolean | undefined>,
  ): { page: number | null; big: bigint | null; flag: boolean | null } {
    return { page: page ?? null, big: big ?? null, flag: flag ?? null };
  }

  // 连字符键与 cookie 键:Header 单键对原生 Headers 大小写不敏感。
  @Get("/headers-probe")
  headersProbe(
    tenant: Header<"x-tenant-id" | undefined>,
    cookie: Header<"cookie" | undefined>,
  ): { tenant: string | null; cookie: string | null } {
    return { tenant: tenant ?? null, cookie: cookie ?? null };
  }

  // @ResponseStatus + Headers 槽 + 用户 Set-Cookie:201 与分条 set-cookie 同响应出线;
  // 白名单靠先存变量再 return(直接字面量会被 TS2353 挡住,验不到运行时投影)。
  @Post()
  @ResponseStatus(201)
  create(name: Body<CreateUserBody, "name">, headers: Headers): { name: string } {
    headers.append("set-cookie", stringifySetCookie("order", name));
    headers.append("set-cookie", stringifySetCookie("session", "abc"));
    const row = { name, internal: "not-on-the-wire" };
    return row;
  }

  // 响应契约两种写法之一:无 @ResponseSchema,返回类型自映射线上契约。
  @Get("/wire-typed")
  wireTyped(): { id: string; total: number } {
    return { id: "42", total: 10 };
  }

  // 之二:@ResponseSchema 的 input 侧即线上契约,handler 直返域对象(bigint id),
  // 编码器把 string 叶上的 bigint 归一成串——两种写法线上产出一致。
  @Get("/wire-schema")
  @ResponseSchema(orderWireSchema)
  wireSchema(): { id: bigint; total: number } {
    return { id: 42n, total: 10 };
  }

  // 三层嵌套深处的多余字段同样不出线。
  @Get("/nested")
  nested(): { level1: { level2: { keep: string } } } {
    const row = { level1: { level2: { keep: "yes", drop: "no" } } };
    return row;
  }

  // @Throws 声明线上错误集合:类型化处理器决定状态码与 body(见 web-errors.ts)。
  @Get("/checkout")
  @Throws(OrderRejectedError, QuotaExceededError)
  checkout(fail: Query<"fail" | undefined>): { ok: boolean } {
    if (fail === "order") {
      throw new OrderRejectedError(42n);
    }
    if (fail === "quota") {
      throw new QuotaExceededError("quota exceeded");
    }
    return { ok: true };
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
  // @Throws 认 defineHttpError 造的 const（#310）：无处理器可绑，声明的意义是把 409 写进
  // routes.json 与 openapi 的响应集合；const 不导出也行——manifest 不需要 import 它。
  @Get("/conflict")
  @Throws(GreetingAlreadyExists)
  conflict(): Response {
    throw new GreetingAlreadyExists(["Lynch"]);
  }
}
