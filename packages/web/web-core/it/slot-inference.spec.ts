import { describe, expect, test } from "vitest";
import type { Body, Header, Param, Query } from "@/routing/slots";

// 槽位透明别名的推导契约(RFC 0012 S2,#274):参数声明什么类型,handler 体内就拿到什么
// 类型。别名本身零运行时,这里钉的是"四种写法 + 可选单键 + 第四档投影"的类型面——纯类型
// 推导不单测,但这是公开 API 的行为契约,套 schema-inference.spec.ts 的 Exact 形式钉住。

interface SnowflakeParams {
  readonly id: bigint;
  readonly orgId: bigint;
}

interface CreateUserBody {
  readonly name: string;
  readonly age: number;
}

// 精确相等（不是"可赋值"）：单向可赋值证明不了什么——any 对任何目标都可赋值。
type Exact<Actual, Expected> =
  (<T>() => T extends Actual ? 1 : 2) extends <T>() => T extends Expected ? 1 : 2 ? true : false;

function verifySingleKeyDefaultsToString(id: Param<"id">): void {
  const isString: Exact<typeof id, string> = true;
  void isString;
}

function verifySingleKeyCarriesItsValueType(id: Param<"id", bigint>): void {
  const isBigint: Exact<typeof id, bigint> = true;
  void isBigint;
}

function verifyOptionalSingleKeyAddsUndefined(tenant: Header<"x-tenant-id" | undefined>): void {
  const isOptionalString: Exact<typeof tenant, string | undefined> = true;
  void isOptionalString;
}

function verifyExplicitOptionalValueType(page: Query<"page", number | undefined>): void {
  const isOptionalNumber: Exact<typeof page, number | undefined> = true;
  void isOptionalNumber;
}

function verifyQueryArrayValueType(tags: Query<"tag", string[]>): void {
  const isArray: Exact<typeof tags, string[]> = true;
  void isArray;
}

function verifyContractFormIsTheWholeContract(params: Param<SnowflakeParams>): void {
  const isContract: Exact<typeof params, SnowflakeParams> = true;
  void isContract;
}

function verifyContractProjectionPicksOneField(id: Param<SnowflakeParams, "id">): void {
  const isBigint: Exact<typeof id, bigint> = true;
  void isBigint;
}

function verifyBodyContract(body: Body<CreateUserBody>): void {
  const isContract: Exact<typeof body, CreateUserBody> = true;
  void isContract;
}

function verifyBodyProjection(name: Body<CreateUserBody, "name">): void {
  const isString: Exact<typeof name, string> = true;
  void isString;
}

function verifyProjectionTypoIsARealTypeError(): void {
  // @ts-expect-error 投影键拼错必须在标注处报 TS2344,不能静默落回整契约。
  type Bad = Param<SnowflakeParams, "typo">;
  // @ts-expect-error Body 的投影键同样受 keyof 约束。
  type BadBody = Body<CreateUserBody, "nmae">;
  const unusedProbe: [Bad, BadBody] | undefined = undefined;
  void unusedProbe;
}

void verifySingleKeyDefaultsToString;
void verifySingleKeyCarriesItsValueType;
void verifyOptionalSingleKeyAddsUndefined;
void verifyExplicitOptionalValueType;
void verifyQueryArrayValueType;
void verifyContractFormIsTheWholeContract;
void verifyContractProjectionPicksOneField;
void verifyBodyContract;
void verifyBodyProjection;
void verifyProjectionTypoIsARealTypeError;

describe("slot alias transparency", () => {
  test("slot aliases erase to their selected value types at runtime call sites", () => {
    const takeId = (id: Param<"id", bigint>): bigint => id;
    const takeBody = (body: Body<CreateUserBody, "name">): string => body;

    expect(takeId(42n)).toBe(42n);
    expect(takeBody("reforce")).toBe("reforce");
  });
});
