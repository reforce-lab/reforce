// @LoggerName（RFC 0011 L2，#242）：覆盖编译器为一个类推导出的 logger 名。
//
// 只能是**类装饰器**，不是参数装饰器：本仓用的是 TC39 标准装饰器
// （tooling/tsconfig 的 experimentalDecorators: false），标准装饰器根本没有参数装饰器这一位，
// IR 里也只有类/方法/属性三个装饰器位。语义上类级也更对——一个类一个 logger 名，同一个类的
// 两个构造参数拿到两个不同名字的 logger 只会让日志更难读。
//
// 运行时是恒等函数：名字在编译期就被读走并内联进生成的 bean 了，这里不需要留下任何东西。
// 保留它是为了让装饰器在运行时不报错，以及让「名字写在哪」对读代码的人可见。
export function LoggerName(name: string) {
  return <T>(value: T, _context: ClassDecoratorContext): T => {
    void name;
    return value;
  };
}
