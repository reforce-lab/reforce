import {
  type Body,
  Controller,
  Get,
  type Param,
  Post,
  type Query,
  ResponseStatus,
  Throws,
  Use,
} from "@reforce/web-core";
import type {
  CreateGreetingBody,
  GreetingParams,
  GreetingQuery,
  GreetingView,
} from "@/features/greeting/greeting.dto";
import { GreetingAlreadyExists } from "@/features/greeting/greeting.exception";
import type { GreetingService } from "@/features/greeting/greeting.service";
import { ApiKeyMiddleware } from "@/infrastructure/web/api-key.middleware";
import { type Paginated, paginate, type PaginationQuery } from "@/shared/pagination/pagination.dto";

@Controller("/greetings")
export class GreetingController {
  // 上面用 import type 引 GreetingService 就够了：注入关系在编译期解析完，运行时由生成的
  // 容器代码去 import 那个类，这里不需要留一条真实的模块依赖。ApiKeyMiddleware 相反——
  // @Use 收的是类本身这个值，所以必须是普通 import。
  constructor(private readonly greetings: GreetingService) {}

  // 参数的类型标注就是输入契约：Query<PaginationQuery> 表示整个查询串按 PaginationQuery
  // 校验后整体给我。返回类型就是响应契约：Paginated<GreetingView> 声明外的字段不出线。
  // 两头都只是类型标注，没有运行时登记。
  @Get()
  list(query: Query<PaginationQuery>): Paginated<GreetingView> {
    return paginate(this.greetings.list(query.order), query);
  }

  // 投影写法：校验仍按整个契约跑（错一个字段照样 400），参数值按第二个类型实参的键取出，
  // handler 只用一个字段时就不必收整个对象。
  @Get("/:name")
  show(name: Param<GreetingParams, "name">, times: Query<GreetingQuery, "times">): GreetingView {
    // 返回值是一条完整的 GreetingRecord，带着 internalNote。TypeScript 这里不拦——已有类型
    // 上的多余字段在结构类型下是合法赋值，它只对内联写出来的对象字面量做多余字段检查。
    // 返回类型契约补上了这一刀：没声明的字段不出线。curl 一下，body 里只有 name 和 message。
    return this.greetings.find(name, times);
  }

  // @Use 把中间件挂在这一条路由上（挂在类上就是整组路由）。读接口不需要 API key，写接口
  // 需要——这就是为什么它不写成 global。挂载顺序不影响执行顺序，链上的先后永远由中间件
  // 自己的 (phase, order) 决定。
  //
  // @ResponseStatus 改掉成功状态码：创建资源按惯例回 201，缺省是 200。
  //
  // @Throws 把「这条路由会怎么失败」写进契约：GreetingAlreadyExists 撞名时回 409。它只是
  // 声明——service 抛出后由框架直接翻成 problem+json（见 greeting.exception.ts），这里声明的
  // 意义是让 routes.json 与 `reforce openapi` 导出的文档把 409 列成这条路由的响应之一。
  @Use(ApiKeyMiddleware)
  @Post()
  @ResponseStatus(201)
  @Throws(GreetingAlreadyExists)
  create(body: Body<CreateGreetingBody>): GreetingView {
    return this.greetings.create(body.name, body.message);
  }
}
