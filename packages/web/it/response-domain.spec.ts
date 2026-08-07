import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, test } from "vitest";
import { Controller, Get, ResponseSchema } from "@/routing/decorators";

// @ResponseSchema 返回位的类型面契约（RFC 0012 S3，#275）：线上契约 C = InferInput<S>，
// handler 返回域 R = ResponseDomain<C>——string 叶放宽到 string | bigint | Date（编码器归一
// 成串），字面量叶与其余形状逐字相等。这是纯类型推导，但属于公开 API 的行为契约，照
// slot-inference.spec.ts 用真 tsc 钉住正负向。

interface OrderWire {
  readonly id: string;
  readonly kind: "standard" | "express";
  readonly total: number;
  readonly createdAt: string;
  readonly lines: readonly { readonly sku: string; readonly quantity: number }[];
}

// 类型面探针只需要 InferInput 形状；validate 永不执行，返回 issues 免去对 T 的伪造。
function wireSchemaOf<T>(): StandardSchemaV1<T, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "reforce-it",
      validate: () => ({ issues: [{ message: "type-only probe" }] }),
    },
  };
}

const orderSchema = wireSchemaOf<OrderWire>();

interface OrderRow {
  readonly id: bigint;
  readonly kind: "standard" | "express";
  readonly total: number;
  readonly createdAt: Date;
  readonly lines: readonly { readonly sku: string; readonly quantity: number }[];
}

@Controller("/orders")
class Orders {
  // 正向：string 叶接受 bigint（id）与 Date（createdAt），域对象直接返回。
  @Get("/domain")
  @ResponseSchema(orderSchema)
  domain(): OrderRow {
    return {
      id: 42n,
      kind: "standard",
      total: 10,
      createdAt: new Date(0),
      lines: [{ sku: "a", quantity: 1 }],
    };
  }

  // 正向：async handler 的 Promise<R> 同样落进返回位约束。
  @Get("/async")
  @ResponseSchema(orderSchema)
  async asyncDomain(): Promise<OrderRow> {
    return this.domain();
  }

  // 正向：与线上契约完全一致的返回类型当然合法。
  @Get("/exact")
  @ResponseSchema(orderSchema)
  exact(): OrderWire {
    return {
      id: "42",
      kind: "express",
      total: 10,
      createdAt: "1970-01-01T00:00:00.000Z",
      lines: [],
    };
  }
}

interface KindDrifted {
  readonly id: string;
  // 字面量叶不参与放宽：string extends "standard" 为假，宽 string 必须在套用处硬错。
  readonly kind: string;
  readonly total: number;
  readonly createdAt: string;
  readonly lines: readonly { readonly sku: string; readonly quantity: number }[];
}

interface ShapeDrifted {
  readonly id: string;
  readonly kind: "standard" | "express";
  // number 叶没有放宽通道：bigint 进不了 number 叶。
  readonly total: bigint;
  readonly createdAt: string;
  readonly lines: readonly { readonly sku: string; readonly quantity: number }[];
}

@Controller("/broken")
class Broken {
  @Get("/literal")
  // @ts-expect-error 字面量叶（"standard" | "express"）不接受宽 string。
  @ResponseSchema(orderSchema)
  literalWidened(): KindDrifted {
    return this.probeKind();
  }

  @Get("/shape")
  // @ts-expect-error number 叶不接受 bigint，形状偏差在装饰器套用处硬错。
  @ResponseSchema(orderSchema)
  shapeDrifted(): ShapeDrifted {
    return this.probeShape();
  }

  @Get("/missing")
  // @ts-expect-error 缺字段（少 lines）不满足线上契约。
  @ResponseSchema(orderSchema)
  missingField(): Omit<OrderWire, "lines"> {
    return { id: "1", kind: "standard", total: 0, createdAt: "" };
  }

  private probeKind(): KindDrifted {
    return { id: "1", kind: "anything", total: 0, createdAt: "", lines: [] };
  }

  private probeShape(): ShapeDrifted {
    return { id: "1", kind: "standard", total: 0n, createdAt: "", lines: [] };
  }
}

describe("ResponseSchema return-position contract", () => {
  test("the decorator stays a runtime no-op on relaxed domain returns", () => {
    const orders = new Orders();

    expect(orders.domain().id).toBe(42n);
    expect(new Broken()).toBeInstanceOf(Broken);
  });
});
