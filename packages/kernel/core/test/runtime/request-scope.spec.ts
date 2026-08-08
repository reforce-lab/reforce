import { describe, expect, test } from "vitest";
import {
  currentRequestFacts,
  RequestScope,
  RequestStore,
  runWithRequestFacts,
} from "@/runtime/request-scope";

// 请求作用域与请求事实合用一个模块级 ALS（#380）。两者的隔离规则**故意不同**，这一组用例
// 钉住的正是那条不对称：实例仓认主（认错就会安静地取到别人那次请求的实例），请求事实不认主
// （method/requestId 是关于这次 HTTP 请求的事实，与哪个 context 无关）。

describe("request store ownership", () => {
  test("a scope reads back the store it opened", () => {
    const scope = new RequestScope();
    const store = new RequestStore();

    const observed = scope.run(store, undefined, () => scope.active());

    expect(observed).toBe(store);
  });

  test("another scope sees no active store inside a foreign request", () => {
    const owner = new RequestScope();
    const stranger = new RequestScope();

    const observed = owner.run(new RequestStore(), undefined, () => stranger.active());

    expect(observed).toBeUndefined();
  });

  test("a facts-only scope carries no store at all", () => {
    const scope = new RequestScope();

    const observed = runWithRequestFacts({ requestId: "r-1" }, () => scope.active());

    expect(observed).toBeUndefined();
  });

  test("the store is gone again once the scope has closed", () => {
    const scope = new RequestScope();

    scope.run(new RequestStore(), undefined, () => undefined);

    expect(scope.active()).toBeUndefined();
  });
});

describe("request facts", () => {
  test("facts opened by one scope are readable without owning it", () => {
    const owner = new RequestScope();

    const observed = owner.run(new RequestStore(), { requestId: "r-1" }, () =>
      currentRequestFacts(),
    );

    expect(observed).toEqual({ requestId: "r-1" });
  });

  test("a facts-only scope publishes its facts", () => {
    const observed = runWithRequestFacts({ requestId: "r-2" }, () => currentRequestFacts());

    expect(observed).toEqual({ requestId: "r-2" });
  });

  test("a scope opened without facts publishes none", () => {
    const scope = new RequestScope();

    const observed = scope.run(new RequestStore(), undefined, () => currentRequestFacts());

    expect(observed).toBeUndefined();
  });

  test("no facts are readable outside any scope", () => {
    expect(currentRequestFacts()).toBeUndefined();
  });
});
