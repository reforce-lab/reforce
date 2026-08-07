// 异常只表达「发生了什么」，不表达 HTTP 状态码——翻译成 404 是
// infrastructure/web/ 里错误处理器的事。这条分工决定了异常放在 shared/ 而不是
// infrastructure/：抛它的是 features/ 里的业务代码，放进 infrastructure 就等于让业务反向
// 依赖基础设施，而这套目录分层的全部价值就在于方向反过来。
//
// 放 shared/http/ 是因为它通用到谁都可能抛。只有某个模块会抛的，住在那个模块目录里
// （见 features/greeting/greeting.exception.ts）。
//
// 继承 Error 而不是自己造一套：instanceof、stack、console 打印都是现成的。
export class NotFoundException extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundException";
  }
}
