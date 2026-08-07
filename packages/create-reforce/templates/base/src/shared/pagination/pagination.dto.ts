import { z } from "zod";
import { SORT_ORDERS } from "@/shared/pagination/sort-order.enum";

// 分页是每个列表接口都要的公共形状，所以放 shared/，由各 feature 的 dto 拼进自己的
// schema 里。同目录的 sort-order.enum.ts 跟它是同一个概念的另一块——shared/ 下面按**概念**
// 分目录，不按文件种类分：把 dto 全塞一个目录、enum 全塞另一个目录，就是把「按类型分」
// 那套毛病换个地方再犯一遍。
//
// 注意「公用 DTO」和「某个模块的 DTO 恰好被别人用了」不是一回事：前者是谁都可能用的通用
// 概念（分页、Money、时间区间），进 shared；后者是耦合，挪进 shared 只是把它藏起来，A 改
// 字段照样打到 B——那种情况让 B 走 A 的 service 拿数据。

export const paginationQuery = z.object({
  // 查询串永远是字符串，coerce 负责转成数字；缺省由 default 补上。
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
  order: z.enum(SORT_ORDERS).default("asc"),
});

export type PaginationQuery = z.infer<typeof paginationQuery>;

// 列表响应的外壳：把「一页数据长什么样」这件事收在一处，各 feature 只提供 item 的形状。
export function paginated<Item extends z.ZodType>(item: Item) {
  return z.object({
    total: z.number().int(),
    page: z.number().int(),
    size: z.number().int(),
    items: z.array(item),
  });
}

export function paginate<Item>(
  items: readonly Item[],
  query: PaginationQuery,
): { total: number; page: number; size: number; items: Item[] } {
  const start = (query.page - 1) * query.size;
  return {
    total: items.length,
    page: query.page,
    size: query.size,
    items: items.slice(start, start + query.size),
  };
}
