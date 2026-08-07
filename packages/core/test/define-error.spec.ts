import { describe, expect, test } from "vitest";
import { defineError } from "@/define-error";
import { isReforceError } from "@/errors";

// 带码错误的内部工厂（ADR 0013 决议 3，#292）。它服务的是「用户 API 的参数校验」那一层，
// 此前全是裸 TypeError——无码、无 help、不进识别。
describe("defineError", () => {
  const Boom = defineError<"CORE_TEST_BOOM", [what: string]>("CORE_TEST_BOOM", "the %s exploded.", {
    base: TypeError,
    help: "stop poking it.",
  });

  test("renders %s slots in order", () => {
    expect(new Boom(["reactor"]).message).toBe("the reactor exploded.");
  });

  test("carries its code", () => {
    expect(new Boom(["reactor"]).code).toBe("CORE_TEST_BOOM");
  });

  test("carries its help", () => {
    expect(new Boom(["reactor"]).help).toBe("stop poking it.");
  });

  // 保留标准库语义是 base 存在的全部理由：用户已经写下的 `catch (e) { if (e instanceof
  // TypeError) … }` 不能因为框架给错误补了个码就失效。
  test("keeps the standard-library base in the prototype chain", () => {
    expect(new Boom(["reactor"])).toBeInstanceOf(TypeError);
  });

  test("defaults to Error when no base is given", () => {
    const Plain = defineError<"CORE_TEST_PLAIN">("CORE_TEST_PLAIN", "plain.");

    expect(new Plain([])).toBeInstanceOf(Error);
    expect(new Plain([])).not.toBeInstanceOf(TypeError);
  });

  // 造出的类 extends TypeError，与 ReforceError 是两条继承链——这正是决议 1 把识别做成形状
  // 守卫而不是 instanceof 的价值。
  test("enters the lineage through the marker, not through ReforceError", () => {
    expect(isReforceError(new Boom(["reactor"]))).toBe(true);
  });

  // 栈首行既要保留标准库类型（读者据它判断这是不是参数问题），又要带上可查询的码。
  test("names itself after its base and code", () => {
    expect(new Boom(["reactor"]).name).toBe("TypeError [CORE_TEST_BOOM]");
  });

  test("leaves help undefined when none is given", () => {
    const Plain = defineError<"CORE_TEST_PLAIN">("CORE_TEST_PLAIN", "plain.");

    expect(new Plain([]).help).toBeUndefined();
  });

  // 槽位比实参多时不能把 "undefined" 印进消息以外的地方，也不能抛——消息是给人读的，
  // 少一个实参最差就是少一个词。
  test("renders a missing argument as undefined rather than throwing", () => {
    const TwoSlots = defineError<"CORE_TEST_TWO", [a: string, b: string]>(
      "CORE_TEST_TWO",
      "%s then %s.",
    );

    expect(new TwoSlots(["first"] as unknown as [string, string]).message).toBe(
      "first then undefined.",
    );
  });
});
