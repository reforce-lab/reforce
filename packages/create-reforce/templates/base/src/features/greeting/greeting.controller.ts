import { Controller, Get, Post, type RequestContext, Use } from "@reforce/web";
import { createGreeting, listGreetings, showGreeting } from "@/features/greeting/greeting.dto";
import type { GreetingService } from "@/features/greeting/greeting.service";
import { ApiKeyMiddleware } from "@/infrastructure/web/api-key.middleware";
import { paginate } from "@/shared/pagination/pagination.dto";

@Controller("/greetings")
export class GreetingController {
  // 上面用 import type 引 GreetingService 就够了：注入关系在编译期解析完，运行时由生成的
  // 容器代码去 import 那个类，这里不需要留一条真实的模块依赖。ApiKeyMiddleware 相反——
  // @Use 收的是类本身这个值，所以必须是普通 import。
  constructor(private readonly greetings: GreetingService) {}

  // handler 的参数必须显式标注类型——TypeScript 不会给类方法的参数做上下文推导。标注里的
  // typeof showGreeting 把 schema 的类型接了过来，所以 context.params.name 直接是 string、
  // context.query.times 直接是 number。
  @Get("", listGreetings)
  list(context: RequestContext<typeof listGreetings>) {
    return paginate(this.greetings.list(context.query.order), context.query);
  }

  @Get("/:name", showGreeting)
  show(context: RequestContext<typeof showGreeting>) {
    // 返回值是一条完整的 GreetingRecord，带着 internalNote。TypeScript 这里不拦——已有类型
    // 上的多余字段在结构类型下是合法赋值，它只对内联写出来的对象字面量做多余字段检查。
    // 出参 schema 补上了这一刀：没声明的字段不出线。curl 一下，body 里只有 name 和 message。
    return this.greetings.find(context.params.name, context.query.times);
  }

  // @Use 把中间件挂在这一条路由上（挂在类上就是整组路由）。读接口不需要 API key，写接口
  // 需要——这就是为什么它不写成 global。挂载顺序不影响执行顺序，链上的先后永远由中间件
  // 自己的 (phase, order) 决定。
  @Use(ApiKeyMiddleware)
  @Post("", createGreeting)
  create(context: RequestContext<typeof createGreeting>) {
    return this.greetings.create(context.body.name, context.body.message);
  }
}
