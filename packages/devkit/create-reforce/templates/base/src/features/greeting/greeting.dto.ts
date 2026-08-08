import { z } from "zod";

// dto = 这个 feature 的对外形状。请求怎么校验、响应长什么样，都写在这一个文件里，
// controller 只负责引用。
//
// 请求侧用 zod：schema 管校验，`z.infer<typeof x>` 别名把类型接给 controller 的参数标注，
// 编译器沿 typeof 把标注追溯回这里的 schema 值，解码就交给它。所以每个被引用的 schema
// 都必须是**顶层的具名导出**——写成内联字面量，编译期就找不到了。
//
// 响应侧不需要 schema：返回类型本身就是线上契约，一个 interface 就够（见 GreetingView）。

export const greetingParams = z.object({
  name: z.string().min(1).max(40),
});
export type GreetingParams = z.infer<typeof greetingParams>;

// 查询串的值永远是字符串。coerce 负责把 "3" 变成 3，所以 handler 拿到的已经是 number；
// 缺省时 default 补 1。校验不过直接 400，轮不到 handler。
export const greetingQuery = z.object({
  times: z.coerce.number().int().min(1).max(5).default(1),
});
export type GreetingQuery = z.infer<typeof greetingQuery>;

export const createGreetingBody = z.object({
  name: z.string().min(1).max(40),
  message: z.string().min(1).max(200),
});
export type CreateGreetingBody = z.infer<typeof createGreetingBody>;

// 响应契约 = handler 的返回类型，这个 interface 就是**字段白名单**：只有这里声明过的字段
// 才会出现在响应里。GreetingRecord 上还有一个 internalNote，handler 把整条记录原样返回也
// 不会出线——这一层挡的就是「实体里多了个敏感字段，忘了在某个接口上剥掉」这类事故，
// 靠人记得剥是靠不住的。
export interface GreetingView {
  readonly name: string;
  readonly message: string;
}
