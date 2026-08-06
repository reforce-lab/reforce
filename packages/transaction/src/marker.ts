import { defineMethodMarker } from "@reforce/context";
import type { TransactionIsolation } from "@/manager";
import { transactionIsolationLevels } from "@/manager";

// @Transactional（ADR 0008 T3，#204 定案 2）：走 AM1 defineMethodMarker 通道零特权——字面量
// 参数编译期提取进织入表、经 ctx.value 读回；"transactional" 是保留 key，用户声明同名标记
// 编译期硬错。传播三种；无 rollbackFor/noRollbackFor（JS 无 checked exception，任何 throw 回滚）。

const transactionPropagations = ["REQUIRED", "REQUIRES_NEW", "NESTED"] as const;

export type TransactionPropagation = (typeof transactionPropagations)[number];

// type 而非 interface：MethodMetaValue 的对象分支靠隐式索引签名匹配，interface 没有。
export type TransactionalValue = {
  readonly propagation?: TransactionPropagation;
  readonly isolation?: TransactionIsolation;
  // 整个事务边界的墙钟上限（毫秒，正整数）。语义与归属判据见 TransactionOptions.timeout。
  readonly timeout?: number;
};

export const Transactional = defineMethodMarker<TransactionalValue | undefined>("transactional");

function memberOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function readEnum<T extends string>(
  value: object,
  key: string,
  values: readonly T[],
): T | undefined {
  const entry: unknown = Reflect.get(value, key);
  if (entry === undefined || memberOf(values, entry)) {
    return entry;
  }
  throw new TypeError(
    `Transactional ${key} must be one of ${values.map((item) => JSON.stringify(item)).join(", ")}.`,
  );
}

function readTimeout(value: object): number | undefined {
  const timeout: unknown = Reflect.get(value, "timeout");
  if (timeout === undefined) {
    return undefined;
  }
  if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout <= 0) {
    throw new TypeError("Transactional timeout must be a positive integer number of milliseconds.");
  }
  return timeout;
}

const transactionalOptionKeys = new Set(["propagation", "isolation", "timeout"]);

// 拦截器入口的运行时守卫（#204 测试 N6）：编译器已保证织入表里的值合法，这里兜住未经编译的
// 调用方（Interceptor 参数守卫同族）。返回重建的窄化对象，不做断言。
export function readTransactionalValue(value: unknown): TransactionalValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Transactional value must be an object literal when provided.");
  }
  for (const key of Object.keys(value)) {
    if (!transactionalOptionKeys.has(key)) {
      throw new TypeError(`Transactional value does not include "${key}".`);
    }
  }
  const propagation = readEnum(value, "propagation", transactionPropagations);
  const isolation = readEnum(value, "isolation", transactionIsolationLevels);
  const timeout = readTimeout(value);
  return {
    ...(propagation === undefined ? {} : { propagation }),
    ...(isolation === undefined ? {} : { isolation }),
    ...(timeout === undefined ? {} : { timeout }),
  };
}
