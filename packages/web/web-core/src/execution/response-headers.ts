// 响应头载体（#373）。
//
// 框架自己每请求往响应头里写三条：content-type、content-length、x-request-id。此前它们直接写
// 进一个标准 `Headers`，于是每个请求无条件付一次 `new Headers()` 加三次 `set()`（每次都过一遍
// WebIDL 的 ByteString 校验与名字归一），写出时引擎再 `forEach` 一遍加一次 `getSetCookie()`
// （后者恒定分配一个数组）。逐层压测这一项是 0.60 微秒/请求（#373 顶楼的 L5→L6）。
//
// 而绝大多数路由的用户代码根本不碰响应头。所以框架自己的写落在这个轻量载体上，只有真的有人
// 要标准 `Headers` 时才物化——和 #341 对请求侧做的是同一招。
//
// **用户面一个字没变**：handler 里裸标注 `Headers` 的参数仍然拿到标准 `Headers`（编译器为那个
// 槽位发射 `context.responseHeaders.standard()`），只是声明了它的那条路由自己付这笔钱。
// RFC 0012 S2 的「handler 的 Headers 参数与中间件共用同一个实例」也仍然成立：物化之后本类
// 的每个方法都转发给那一个 `Headers`，任一时刻只有一个真相。

/** 未物化时的空 set-cookie 结果。共享常量，免得每个响应都分配一个空数组。 */
const noCookies: readonly string[] = Object.freeze([]);

export class ResponseHeaders {
  // 三个字段互斥：standardHeaders 一旦存在，另两个恒为 undefined。
  private plain: Map<string, string> | undefined;
  private cookies: string[] | undefined;
  private standardHeaders: Headers | undefined;

  /** 包住一个已经存在的标准 `Headers`（自建 harness、测试替身）。视同已物化。 */
  static from(headers: Headers): ResponseHeaders {
    const carrier = new ResponseHeaders();
    carrier.standardHeaders = headers;
    return carrier;
  }

  set(name: string, value: string): void {
    if (this.standardHeaders !== undefined) {
      this.standardHeaders.set(name, value);
      return;
    }
    const key = name.toLowerCase();
    if (key === "set-cookie") {
      this.cookies = [value];
      return;
    }
    this.plain ??= new Map();
    this.plain.set(key, value);
  }

  // 同名多值按 HTTP 语义并成逗号串，set-cookie 例外——逗号串会被浏览器当成一条 cookie，
  // 必须逐条留着（与标准 Headers 的 getSetCookie 语义一致）。
  append(name: string, value: string): void {
    if (this.standardHeaders !== undefined) {
      this.standardHeaders.append(name, value);
      return;
    }
    const key = name.toLowerCase();
    if (key === "set-cookie") {
      this.cookies ??= [];
      this.cookies.push(value);
      return;
    }
    this.plain ??= new Map();
    const existing = this.plain.get(key);
    this.plain.set(key, existing === undefined ? value : `${existing}, ${value}`);
  }

  get(name: string): string | null {
    if (this.standardHeaders !== undefined) {
      return this.standardHeaders.get(name);
    }
    const key = name.toLowerCase();
    if (key === "set-cookie") {
      return this.cookies === undefined ? null : this.cookies.join(", ");
    }
    return this.plain?.get(key) ?? null;
  }

  has(name: string): boolean {
    return this.get(name) !== null;
  }

  delete(name: string): void {
    if (this.standardHeaders !== undefined) {
      this.standardHeaders.delete(name);
      return;
    }
    const key = name.toLowerCase();
    if (key === "set-cookie") {
      this.cookies = undefined;
      return;
    }
    this.plain?.delete(key);
  }

  // 与标准 Headers.forEach 同签名同语义（值在前、名在后，set-cookie 并成逗号串）：引擎的写出
  // 循环因此一个字都不用改，仍然是「forEach 里跳过 set-cookie，再单独走 getSetCookie」。
  forEach(visit: (value: string, name: string) => void): void {
    if (this.standardHeaders !== undefined) {
      this.standardHeaders.forEach(visit);
      return;
    }
    if (this.plain !== undefined) {
      for (const [name, value] of this.plain) {
        visit(value, name);
      }
    }
    if (this.cookies !== undefined) {
      visit(this.cookies.join(", "), "set-cookie");
    }
  }

  getSetCookie(): readonly string[] {
    if (this.standardHeaders !== undefined) {
      return this.standardHeaders.getSetCookie();
    }
    return this.cookies ?? noCookies;
  }

  /**
   * 物化成标准 `Headers`，并从此以它为唯一真相——本类之后的每个方法都转发给它。
   *
   * 走到这里的只有两种情况：handler 裸标注了 `Headers` 参数，或者用户读了
   * `context.responseHeaders.standard()`。两者都是显式声明「我要标准对象」。
   */
  standard(): Headers {
    if (this.standardHeaders !== undefined) {
      return this.standardHeaders;
    }
    // 显式标注:不标注时推导类型指向 undici-types 的 Headers,d.ts 生成报 TS2883 不可移植。
    const headers: Headers = new Headers();
    if (this.plain !== undefined) {
      for (const [name, value] of this.plain) {
        headers.set(name, value);
      }
    }
    if (this.cookies !== undefined) {
      for (const cookie of this.cookies) {
        headers.append("set-cookie", cookie);
      }
    }
    this.plain = undefined;
    this.cookies = undefined;
    this.standardHeaders = headers;
    return headers;
  }
}
