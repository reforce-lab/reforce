import { Injectable } from "@reforce/core";
import { GreetingAlreadyExistsException } from "@/features/greeting/greeting.exception";
import { NotFoundException } from "@/shared/http/not-found.exception";
import type { SortOrder } from "@/shared/pagination/sort-order.enum";

// 领域里的一条记录。internalNote 是内部字段，不该出现在响应里——greeting.dto.ts 的
// 出参 schema 负责把它挡在外面。
export interface GreetingRecord {
  readonly name: string;
  readonly message: string;
  readonly internalNote: string;
}

// 端口声明在消费方这一侧：service 说「我需要一个能存取问候语的东西」，至于它是内存 Map
// 还是数据库，由 infrastructure/ 里的实现去闭合。容器按类型匹配接线，所以以后换实现不用
// 动这个文件。
export interface GreetingStore {
  find(name: string): GreetingRecord | undefined;
  list(): readonly GreetingRecord[];
  save(record: GreetingRecord): void;
}

// @Injectable() 把这个类交给容器管理。编译期会扫描整个 src/ 找到它，所以新建一个 service
// 不需要在别的地方登记，也不需要从入口文件导出。
@Injectable()
export class GreetingService {
  // 构造参数就是依赖声明。这里声明的是接口，容器去找唯一实现了它的 bean。
  constructor(private readonly store: GreetingStore) {}

  list(order: SortOrder): readonly GreetingRecord[] {
    const direction = order === "asc" ? 1 : -1;
    return [...this.store.list()].sort(
      (left, right) => left.name.localeCompare(right.name) * direction,
    );
  }

  // 抛异常，不碰 HTTP 状态码：翻译成 404 是 infrastructure/web/ 里错误处理器的事。这样同一
  // 条规则在 HTTP 之外（定时任务、队列消费）复用时也不用改。
  find(name: string, times: number): GreetingRecord {
    const record = this.store.find(name);
    if (record === undefined) {
      throw new NotFoundException(`没有名为 ${name} 的问候语。`);
    }
    return { ...record, message: Array.from({ length: times }, () => record.message).join(" ") };
  }

  create(name: string, message: string): GreetingRecord {
    if (this.store.find(name) !== undefined) {
      throw new GreetingAlreadyExistsException(name);
    }
    const record = { name, message, internalNote: "created by the API" };
    this.store.save(record);
    return record;
  }
}
