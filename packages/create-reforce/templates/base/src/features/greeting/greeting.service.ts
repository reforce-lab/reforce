import { Injectable } from "@reforce/core";
import { NotFoundError } from "@reforce/web";
import { GreetingAlreadyExists } from "@/features/greeting/greeting.exception";
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

  // 抛框架的 HTTP 异常：它自己带着状态码与码，框架会翻译成 404 的 problem+json，不需要
  // 你写任何错误处理器。异常在 HTTP 之外（定时任务、队列消费）复用时也照抛不误——那些场景
  // 里没人读它的状态码，只当普通异常处理。
  find(name: string, times: number): GreetingRecord {
    const record = this.store.find(name);
    if (record === undefined) {
      throw new NotFoundError(`没有名为 ${name} 的问候语。`);
    }
    return { ...record, message: Array.from({ length: times }, () => record.message).join(" ") };
  }

  create(name: string, message: string): GreetingRecord {
    if (this.store.find(name) !== undefined) {
      throw new GreetingAlreadyExists([name]);
    }
    const record = { name, message, internalNote: "created by the API" };
    this.store.save(record);
    return record;
  }
}
