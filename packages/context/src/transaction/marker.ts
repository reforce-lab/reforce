import { defineMethodMarker } from "@/interception/method-marker";
import type { TransactionIsolation } from "@/transaction/manager";
import { transactionIsolationLevels } from "@/transaction/manager";

// @Transactional（ADR 0008 T3，#204 定案 2）：走 AM1 defineMethodMarker 通道零特权——字面量
// 参数编译期提取进织入表、经 ctx.value 读回；"transactional" 是保留 key，用户声明同名标记
// 编译期硬错。传播三种；无 rollbackFor/noRollbackFor（JS 无 checked exception，任何 throw 回滚）。

const transactionPropagations = ["REQUIRED", "REQUIRES_NEW", "NESTED"] as const;

export type TransactionPropagation = (typeof transactionPropagations)[number];

// type 而非 interface：MethodMetaValue 的对象分支靠隐式索引签名匹配，interface 没有。
export type TransactionalValue = {
  readonly propagation?: TransactionPropagation;
  readonly isolation?: TransactionIsolation;
};

export const Transactional = defineMethodMarker<TransactionalValue | undefined>("transactional");

function memberOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

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
    if (key !== "propagation" && key !== "isolation") {
      throw new TypeError(`Transactional value does not include "${key}".`);
    }
  }
  const propagation: unknown = Reflect.get(value, "propagation");
  if (propagation !== undefined && !memberOf(transactionPropagations, propagation)) {
    throw new TypeError(
      `Transactional propagation must be one of ${transactionPropagations
        .map((entry) => JSON.stringify(entry))
        .join(", ")}.`,
    );
  }
  const isolation: unknown = Reflect.get(value, "isolation");
  if (isolation !== undefined && !memberOf(transactionIsolationLevels, isolation)) {
    throw new TypeError(
      `Transactional isolation must be one of ${transactionIsolationLevels
        .map((entry) => JSON.stringify(entry))
        .join(", ")}.`,
    );
  }
  return {
    ...(propagation === undefined ? {} : { propagation }),
    ...(isolation === undefined ? {} : { isolation }),
  };
}
