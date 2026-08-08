// `errors` 命名空间（ADR 0013 决议 8，#296）。用途只有一个：`err instanceof errors.X`——
// 用户要按错误分派时不必逐个 import，四家竞品都给了这个入口（`import { errorCodes } from
// "fastify"`、`import { errors } from "@adonisjs/core"`）。
//
// 因此这里**只收能 instanceof 的错误类**：基类 ReforceError 不收（判「是不是框架错误」用
// isReforceError，它跨副本也成立），码表、守卫、defineError 工厂都不收——它们不是能被
// instanceof 的东西，摆进来只会让读者以为 `errors.` 是「错误相关的一切」。
//
// defineError 造出的那批参数守卫错误也不收：它们是内部实现，用户能撞上但没有理由去
// instanceof（除了 code 与 help 它们没有额外字段，按 isReforceError(err, code) 分派即可）。
export {
  ApplicationCleanupError,
  ApplicationContextStateError,
  ApplicationStartError,
  BeanCreationError,
  BeanDisposalError,
  BeanLifecycleError,
  ConfigBindingError,
  EarlyBeanAccessError,
  InterceptorReenteredError,
  InvalidGeneratedDefinitionError,
  RequestContextMissingError,
  UnregisteredBeanTargetError,
} from "@/errors";
