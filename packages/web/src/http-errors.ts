import { ReforceError } from "@reforce/core";

// 面向用户的异常原语（ADR 0013 决议 6，#294）。此前这一层完全空白：框架给了 @ErrorHandler
// 这个出口，却没有任何异常基类，于是脚手架模板只能教用户自己造裸 `extends Error`，再手维护
// 一张「异常 → 状态码」查表——加一种异常就要记得回来加一行。
//
// 对齐 AdonisJS 的 Exception + createError（四家 Node 框架里最完备的用户异常模型）：异常自己
// 携带状态码与码，error-dispatch 直接翻译成 problem+json（决议 7），用户不必写 handler。
//
// 它进谱系（extends ReforceError）而不是自成一支：那样 isReforceError 认得它，兜底拦截器的
// 放行纪律、reporter 的取码取 help 一次覆盖。

export interface HttpErrorInput<Code extends string> {
  readonly status: number;
  readonly code: Code;
  readonly message: string;
  /** 「下一步怎么办」。不进 HTTP 响应，只进日志与 CLI 呈现——它是给开发者的，不是给调用方的。 */
  readonly help?: string;
  readonly cause?: unknown;
}

// 构造是**公开**的，与谱系里其它错误（protected 构造、只能由框架抛）相反：这一支的全部意义
// 就是让用户在自己的业务代码里 throw。
//
// 参数是一个 options 对象而不是 (message, status, code) 位置参数：加上 help 与 cause 之后位置
// 参数会变成五个，调用点读不出哪个是哪个（同 defineBean / @Interceptor 的惯例）。
export class HttpError<Code extends string = string> extends ReforceError<Code> {
  readonly code: Code;
  readonly status: number;

  constructor(input: HttpErrorInput<Code>) {
    super(input.message, { cause: input.cause, help: input.help });
    this.code = input.code;
    this.status = input.status;
  }
}

export interface HttpErrorOptions {
  readonly help?: string;
  readonly cause?: unknown;
}

// 高频子类取 NestJS 二十个子类里的高频子集，按需增补不求全。status 与 code 已经钉死，
// 因此签名收敛成 (message, options?)——只剩一个必填参数。
//
// 每个都带 WEB_ 前缀的码（决议 2 的前缀纪律管的是框架自己新增的码）。给它们编码而不是留空，
// 是为了让 `code` 这个扩展成员在所有框架产出的错误响应里都在场：客户端才能无条件按 code
// 分派，而不必先判断「这个响应有没有 code」。用户经 defineHttpError 写的码不带前缀——那个
// 命名空间是用户的，框架不该占。
//
// 五个类逐个写全而不是用一个 `httpErrorSubclass(status, code)` mixin 工厂：工厂返回的是匿名
// 类表达式，tsgo 生成 d.ts 时只能把它摊成结构类型（`declare const X_base: { new (…): { … } }`），
// 于是 `instanceof ReforceError` 的名义关系在消费方那侧丢失，还会把 NodeJS.CallSite 拖进
// 公开声明。五份三行的重复换回一份能读的声明面，这笔账划算。
export class BadRequestError extends HttpError<"WEB_BAD_REQUEST"> {
  constructor(message: string, options: HttpErrorOptions = {}) {
    super({ status: 400, code: "WEB_BAD_REQUEST", message, ...options });
  }
}

export class UnauthorizedError extends HttpError<"WEB_UNAUTHORIZED"> {
  constructor(message: string, options: HttpErrorOptions = {}) {
    super({ status: 401, code: "WEB_UNAUTHORIZED", message, ...options });
  }
}

export class ForbiddenError extends HttpError<"WEB_FORBIDDEN"> {
  constructor(message: string, options: HttpErrorOptions = {}) {
    super({ status: 403, code: "WEB_FORBIDDEN", message, ...options });
  }
}

export class NotFoundError extends HttpError<"WEB_NOT_FOUND"> {
  constructor(message: string, options: HttpErrorOptions = {}) {
    super({ status: 404, code: "WEB_NOT_FOUND", message, ...options });
  }
}

export class ConflictError extends HttpError<"WEB_CONFLICT"> {
  constructor(message: string, options: HttpErrorOptions = {}) {
    super({ status: 409, code: "WEB_CONFLICT", message, ...options });
  }
}

export interface DefineHttpErrorOptions {
  readonly help?: string;
}

export interface DefinedHttpErrorConstructor<Code extends string, Args extends readonly unknown[]> {
  new (args: Args, options?: { readonly cause?: unknown }): HttpError<Code>;
}

// 只认 %s，按出现顺序吃 args——与 @reforce/core 的 defineError 同一约定。
function formatMessage(template: string, args: readonly unknown[]): string {
  let index = 0;
  return template.replace(/%s/gu, () => {
    const value = args[index];
    index += 1;
    return String(value);
  });
}

// 一行定义一个带类型参数的业务异常（AdonisJS createError 的位置）。码由用户自己起名，因此
// 不加框架前缀，也不进框架的码表——它属于用户应用的词汇表。
export function defineHttpError<Args extends readonly unknown[] = [], Code extends string = string>(
  code: Code,
  template: string,
  status: number,
  options: DefineHttpErrorOptions = {},
): DefinedHttpErrorConstructor<Code, Args> {
  return class extends HttpError<Code> {
    constructor(args: Args, instanceOptions: { readonly cause?: unknown } = {}) {
      super({
        status,
        code,
        message: formatMessage(template, args),
        help: options.help,
        cause: instanceOptions.cause,
      });
    }
  };
}
