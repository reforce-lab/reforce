import { compilerDiagnosticCodes } from "@reforce/compiler";
import { configErrorCodes } from "@reforce/config";
import { coreErrorCodes } from "@reforce/core";
import { cliFailureCodes } from "@reforce/runtime/error-codes";
import { transactionErrorCodes } from "@reforce/transaction";
import { webErrorCodes } from "@reforce/web";
import { cliErrorCodes } from "@/error-codes";

// 全仓码表的唯一聚合点（ADR 0013 决议 2，#289）。码表本身留在各自的包里——中央注册包会造成
// 反向依赖（容器要反过来依赖 web 才能登记 web 的码）；这里只是把已发布的表读到一起。
//
// 落在 CLI 而不是别处：CLI 是把码呈现给用户的那一端（`reforce explain <CODE>`、诊断行的
// `error[<CODE>]`），本来就必须看得见每张表。决议 5 把 explain 扩展到全部错误码时消费的
// 就是这份聚合。

export type ErrorCodeDomain = "compiler" | "core" | "config" | "transaction" | "web" | "cli";

export interface ErrorCodeTable {
  readonly domain: ErrorCodeDomain;
  readonly codes: readonly string[];
}

// CLI 域的所有者表是 cliFailureCodes 而不是 cliErrorCodes：后者四个码逐字包含在前者里——CLI
// 错误抛出去之后就是 reporter 的失败码，两张表是同一概念的两侧。当成两个所有者去查重会得到
// 四个假阳性，所以包含关系由 conformance 单独断言（cliErrorCodes 仍从这里导出供它使用）。
export const errorCodeTables: readonly ErrorCodeTable[] = [
  { domain: "compiler", codes: compilerDiagnosticCodes },
  { domain: "core", codes: coreErrorCodes },
  { domain: "config", codes: configErrorCodes },
  { domain: "transaction", codes: transactionErrorCodes },
  { domain: "web", codes: webErrorCodes },
  { domain: "cli", codes: cliFailureCodes },
];

export const cliOwnedErrorCodes: readonly string[] = cliErrorCodes;

const ownerByCode: ReadonlyMap<string, ErrorCodeDomain> = new Map(
  errorCodeTables.flatMap((table) => table.codes.map((code) => [code, table.domain] as const)),
);

export function errorCodeDomain(code: string): ErrorCodeDomain | undefined {
  return ownerByCode.get(code);
}

export function isKnownErrorCode(code: string): boolean {
  return ownerByCode.has(code);
}

export function knownErrorCodes(): readonly string[] {
  return [...ownerByCode.keys()].sort();
}
