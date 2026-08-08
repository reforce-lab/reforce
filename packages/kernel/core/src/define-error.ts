import { markReforceError } from "@/error-marker";

// 带码错误的内部工厂（ADR 0013 决议 3，#292）。仿 Node core 的 `E(sym, val, def)` 与
// @fastify/error 的 `createError`：一行声明一个错误类，码、消息模板与 help 写在一处。
//
// 它服务的是「用户 API 的参数校验」这一层——此前全是裸 TypeError，无码、无 help、不进识别，
// 而它恰恰是新手最常撞的一层。
//
// **不进 @reforce/core 根入口**：根入口是应用作者的编程模型面，把一个内部工厂摆进去会让它
// 看起来像用户该用的东西。它从 `@reforce/core/define-error` subpath 导出，只给框架包用
// （目前是 @reforce/core 自己与 @reforce/config）。
//
// **造出的类不是 ReforceError 的子类**：要保留 `instanceof TypeError`，就不可能同时
// `extends ReforceError`（JS 单继承）。这正是决议 1 把识别做成 Symbol.for 形状守卫而不是
// instanceof 的价值——`isReforceError()` 对它们成立，`instanceof ReforceError` 不成立。

// 闭集而不是 `typeof Error`：Error 的子类里只有这三个在标准库里表达「调用方给错了」。
// 其余（SyntaxError / ReferenceError 之类）都是引擎语义，框架借用只会误导读者。
type ErrorBaseConstructor = new (message?: string) => Error;

export interface DefineErrorOptions {
  /** 缺省 Error。参数类型错传 TypeError，值域错传 RangeError——`instanceof` 语义按标准库保留。*/
  readonly base?: ErrorBaseConstructor;
  /** 「下一步怎么办」，与 message 说「发生了什么」分开（RFC 0011 D5，#242）。 */
  readonly help?: string;
}

export interface DefinedError<Code extends string> extends Error {
  readonly code: Code;
  readonly help?: string;
}

export interface DefinedErrorConstructor<Code extends string, Args extends readonly unknown[]> {
  new (args: Args): DefinedError<Code>;
}

// 只认 %s，按出现顺序吃 args。不做 %d/%j：模板全是给人读的一句话，多一种占位符就多一处
// 「这里为什么用 %d」要解释，而 String() 对数字的结果与 %d 无异。
function formatMessage(template: string, args: readonly unknown[]): string {
  let index = 0;
  return template.replace(/%s/gu, () => {
    const value = args[index];
    index += 1;
    return String(value);
  });
}

export function defineError<Code extends string, Args extends readonly unknown[] = []>(
  code: Code,
  template: string,
  options: DefineErrorOptions = {},
): DefinedErrorConstructor<Code, Args> {
  const base: ErrorBaseConstructor = options.base ?? Error;
  // 类名沿用 Node 的 `TypeError [ERR_X]` 形态：栈首行既保留标准库类型（读者据它判断这是
  // 参数问题还是别的），又带上可查询的码。工厂造出的类没有有意义的类名可用。
  const name = `${base.name} [${code}]`;

  return class extends base {
    readonly code = code;
    readonly help = options.help;

    constructor(args: Args) {
      super(formatMessage(template, args));
      this.name = name;
      markReforceError(this);
    }
  };
}
