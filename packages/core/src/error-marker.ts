// 框架错误的身份标记（ADR 0013 决议 1，#280）。识别不能只靠 instanceof：@reforce/core 被装成
// 两份物理拷贝时（starter 版本撕裂，同 ADR 0004 决策 10），web 抛的错误 instanceof 的是另一份
// 拷贝的基类，reporter 这一侧一律判否——@fastify/error 正是因此改按 code 匹配。Symbol.for 走
// 全局注册表，按字符串跨副本同一，识别因此与"哪一份 core 定义了基类"无关。
//
// 单独成模块而不是留在 errors.ts：defineError（决议 3）造出的类 extends TypeError，与
// ReforceError 是两条继承链，但必须打同一个标记；两边都从这里取，标记只有一处定义。
export const reforceErrorMarker = Symbol.for("reforce.error");

// defineProperty 而非字段赋值：默认 non-enumerable，标记因此不会漏进 JSON.stringify、
// 结构化日志的字段展开或 expect(...).toEqual 的对象比较里。
export function markReforceError(error: object): void {
  Object.defineProperty(error, reforceErrorMarker, { value: true });
}
