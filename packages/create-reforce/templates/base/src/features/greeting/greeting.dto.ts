import { z } from "zod";
import { paginated, paginationQuery } from "@/shared/pagination/pagination.dto";

// dto = 这个 feature 的对外形状。请求怎么校验、响应长什么样，都写在这一个文件里，
// controller 只负责引用。
//
// 每个 schema 都必须是**顶层的具名导出**。装饰器只在编译期被读取，运行时是空操作；
// 生成的路由表按「模块 + 导出名」把这些 schema 重新 import 回去——写成内联字面量就找不到了。

export const greetingParams = z.object({
  name: z.string().min(1).max(40),
});

// 查询串的值永远是字符串。coerce 负责把 "3" 变成 3，所以 handler 里 context.query.times
// 拿到的已经是 number；缺省时 default 补 1。校验不过直接 400，轮不到 handler。
export const greetingQuery = z.object({
  times: z.coerce.number().int().min(1).max(5).default(1),
});

export const createGreetingBody = z.object({
  name: z.string().min(1).max(40),
  message: z.string().min(1).max(200),
});

// 出参 schema 是**字段白名单**：只有这里声明过的字段才会出现在响应里。GreetingRecord 上还有
// 一个 internalNote，handler 把整条记录原样返回也不会出线——这一层挡的就是「实体里多了个
// 敏感字段，忘了在某个接口上剥掉」这类事故，靠人记得剥是靠不住的。
export const greetingResponse = z.object({
  name: z.string(),
  message: z.string(),
});

// 分页的形状来自 shared/：这里只提供 item 长什么样。
export const greetingListQuery = paginationQuery;
export const greetingListResponse = paginated(greetingResponse);

// 一次请求用到的几个 schema 收成一个顶层 const，controller 里的类型标注就只用提一次名字。
export const showGreeting = {
  params: greetingParams,
  query: greetingQuery,
  response: greetingResponse,
} as const;

export const listGreetings = {
  query: greetingListQuery,
  response: greetingListResponse,
} as const;

export const createGreeting = {
  body: createGreetingBody,
  response: greetingResponse,
} as const;
