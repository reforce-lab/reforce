import { Injectable } from "@reforce/core";
import type { GreetingRecord } from "@/features/greeting/greeting.service";

// infrastructure/ 放和外部世界、和框架接壤的适配件，按「外部世界的哪一面」分子目录：
// persistence/ 是存储，web/ 是 HTTP 那一面（中间件、错误处理器）。
//
// 这里先用一个内存 Map 顶着。换成真数据库时新写一个类，把 GreetingService 构造参数的
// 类型换过去，容器仍按类型接线。
@Injectable()
export class InMemoryGreetingStore {
  private readonly records = new Map<string, GreetingRecord>([
    ["world", { name: "world", message: "Hello, world!", internalNote: "seed" }],
  ]);

  find(name: string): GreetingRecord | undefined {
    return this.records.get(name);
  }

  list(): readonly GreetingRecord[] {
    return [...this.records.values()];
  }

  save(record: GreetingRecord): void {
    this.records.set(record.name, record);
  }
}
