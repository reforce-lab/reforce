import { ReforceError } from "@reforce/core";
import type { CliErrorCode } from "@/error-codes";

// CLI 这一棵子树（ADR 0013 决议 1，#280）。此前这三个码住在三个各自 `extends Error` 的类里，
// reporter 认不出来，码全靠调用点把 error.code 手抄进 fallbackCode（commands/build.ts、
// commands/start.ts）——每新增一个带码错误都要记得在调用点补一次，漏一处就静默落回兜底码。
// 并入同一个根之后 resolveFailureCode 自己认得，手抄那几处随之删掉。
//
// 空类体：字段、protected 构造与 Symbol.for("reforce.error") 标记全部从根继承，这一层只做
// 「CLI 的码闭集」这一件事，码表本身在 @/error-codes。
export abstract class ReforceCliError<
  Code extends CliErrorCode = CliErrorCode,
> extends ReforceError<Code> {}
