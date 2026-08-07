// `errors` 命名空间（ADR 0013 决议 8，#296）。同 @reforce/core 的那份：只收能 instanceof 的
// 错误类，基类与工厂不收。
//
// HttpError 与五个高频子类**在这里也在根入口**：根入口是用户 throw 它们的地方（`new
// NotFoundError(...)`），命名空间是用户 catch 它们的地方（`err instanceof errors.NotFoundError`），
// 两个场景都高频，逼用户记住「构造走这条路、判断走那条路」是凭空的负担。
export {
  InvalidRouteTableError,
  MiddlewareReenteredError,
  RequestValidationError,
  ResponseSerializationError,
} from "@/errors";
export {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  HttpError,
  NotFoundError,
  UnauthorizedError,
} from "@/http-errors";
