// 模块专属异常：只有 greeting 会抛它，所以它就住在 greeting 这个目录里，不进 shared/。
// 判据和别处一样——改「什么算重复」这条规则时要动的文件，都在同一个目录。
//
// 通用到谁都可能抛的（NotFound / Unauthorized）才进 shared/http/。
export class GreetingAlreadyExistsException extends Error {
  constructor(name: string) {
    super(`已经有名为 ${name} 的问候语了。`);
    this.name = "GreetingAlreadyExistsException";
  }
}
