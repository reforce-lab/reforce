import { Injectable } from "@reforce/core";
import type { GreetingRecord, GreetingStore } from "@/features/greeting/greeting.service";

// infrastructure/ 放和外部世界、和框架接壤的适配件，按「外部世界的哪一面」分子目录：
// persistence/ 是存储，web/ 是 HTTP 那一面（中间件、错误处理器）。
//
// 这里先用一个内存 Map 顶着。换成真数据库时只改这个文件：GreetingService 依赖的是
// GreetingStore 这个接口，容器按类型接线，features/ 一行都不用动。
@Injectable()
export class InMemoryGreetingStore implements GreetingStore {
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
