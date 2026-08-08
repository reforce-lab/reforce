import { compareUtf16CodeUnits } from "@reforce/primitives";
import { providerId } from "@/analysis/model";
import { type ApplicationClassTarget, applicationClassTargetOf } from "@/analysis/web-class-target";
import { type ErrorHandlerInfo, errorHandlerSignatureHelp } from "@/analysis/web-error-handlers";
import type { RouteThrownErrorModel } from "@/analysis/web-model";
import type { CompilerDiagnostic } from "@/api";
import { report } from "@/diagnostics";
import type { ProjectLinker } from "@/linking/project-linker";
import type { DecoratorArgumentValue, DecoratorUse, EntityName } from "@/parser/source-ir";
import type { ParsedSource } from "@/project/source-files";

// @Throws 的解析与处理器匹配（#275；#363 独立成模块）：实参形态裁决、沿语法继承链镜像运行时
// instanceof、defineHttpError 造的异常直接绑内置契约，以及方法级 ∪ 中间件类级的并集。
//
// 单向 import web-error-handlers（要它的名录与 help 文案），反向没有。
export interface ThrowsResolutionContext {
  readonly linker: ProjectLinker;
  // 分派序(order, beanId)下每个 accepts 类键的首个处理器:manifest 绑定的就是运行时赢家。
  readonly handlersByAcceptKey: ReadonlyMap<string, ErrorHandlerInfo>;
  readonly orderedHandlers: readonly ErrorHandlerInfo[];
  readonly diagnostics: CompilerDiagnostic[];
}

// 语法继承链限深:与 web-slots 的 aliasFollowLimit 同一预算——循环 extends 无稳定去重身份。
const heritageFollowLimit = 16;

function heritageClassOf(
  target: ApplicationClassTarget,
  linker: ProjectLinker,
): ApplicationClassTarget | undefined {
  const heritage = target.declaration.heritage;
  // call(extends f(...))与 expression 形态无法静态跟出类身份,继承链在此断开。
  if (heritage?.kind !== "reference") {
    return undefined;
  }
  return applicationClassTargetOf(target.source, heritage.entity, linker);
}

// 镜像运行时 instanceof:@Throws(Sub) 可被收 Base 的处理器满足,沿 source-ir 语法继承链向上。
function handlerForThrownClass(
  target: ApplicationClassTarget,
  context: ThrowsResolutionContext,
): ErrorHandlerInfo | undefined {
  let current: ApplicationClassTarget | undefined = target;
  for (let depth = 0; depth <= heritageFollowLimit && current !== undefined; depth += 1) {
    const handler = context.handlersByAcceptKey.get(current.key);
    if (handler !== undefined) {
      return handler;
    }
    current = heritageClassOf(current, context.linker);
  }
  return undefined;
}

export function resolveThrowsDecorators(
  source: ParsedSource,
  decorators: readonly DecoratorUse[],
  context: ThrowsResolutionContext,
): { readonly throws: readonly RouteThrownErrorModel[]; readonly failed: boolean } {
  const throws: RouteThrownErrorModel[] = [];
  let failed = false;
  for (const decorator of decorators) {
    if (!decorator.called || decorator.arguments.length === 0) {
      failed = true;
      report(
        context.diagnostics,
        "INVALID_ERROR_HANDLER_SIGNATURE",
        "Throws requires at least one application error class argument.",
        decorator.span,
        { help: errorHandlerSignatureHelp },
      );
      continue;
    }
    for (const argument of decorator.arguments) {
      const resolved = resolveThrownArgument(source, argument, context);
      if (resolved === undefined) {
        failed = true;
        continue;
      }
      throws.push(resolved);
    }
  }
  return { throws, failed };
}

// defineHttpError 造的异常(#310):const 初始化是 @reforce/web-core defineHttpError 的直接调用。
// 这类异常没有类声明,类型化处理器的 accepts 写不出来,而运行时兜底闭集(ADR 0013 决议 6/7)
// 直接把 HttpError 翻译成 problem+json——所以 @Throws 直接绑内置契约,不查处理器名录。
// status/code 取实参的静态字面量,写成变量等非字面量时缺省(文档只收静态可知的事实,#306
// 同口径)。
// 状态码合法域与 @ResponseStatus 同口径:非整数或出 100-599 的字面量不落 status——openapi
// 的 responses 键必须是合法状态码,写进去只会砸下游校验器。
function literalStatusOf(argument: DecoratorArgumentValue | undefined): number | undefined {
  if (argument?.kind !== "number-literal") {
    return undefined;
  }
  const value = argument.value;
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

function definedHttpErrorTargetOf(
  source: ParsedSource,
  entity: EntityName,
  linker: ProjectLinker,
): RouteThrownErrorModel | undefined {
  // 只认裸标识符:限定名(NS.X / X.foo)按最左标识符解析会把 X.foo 误认成 X,宁可不认。
  if (entity.kind !== "identifier") {
    return undefined;
  }
  const resolved = linker.resolveValueDeclaration(source, entity.name);
  const name = resolved?.declaration.name;
  if (resolved === undefined || name === undefined) {
    return undefined;
  }
  if (resolved.declaration.declarationKind !== "const") {
    return undefined;
  }
  const initializer = resolved.declaration.initializer;
  if (initializer?.kind !== "call") {
    return undefined;
  }
  const callee = linker.resolveEntity(resolved.source, initializer.callee);
  if (callee?.kind !== "web" || callee.name !== "defineHttpError") {
    return undefined;
  }
  const code = initializer.arguments.at(0);
  const status = literalStatusOf(initializer.arguments.at(2));
  return {
    kind: "http-error",
    errorName: name,
    key: providerId(resolved.source.fileId, name),
    ...(status === undefined ? {} : { status }),
    ...(code?.kind === "string-literal" ? { code: code.value } : {}),
  };
}

function resolveThrownArgument(
  source: ParsedSource,
  argument: DecoratorArgumentValue,
  context: ThrowsResolutionContext,
): RouteThrownErrorModel | undefined {
  const invalid = (): undefined => {
    report(
      context.diagnostics,
      "INVALID_ERROR_HANDLER_SIGNATURE",
      "Throws only accepts application error classes or defineHttpError values.",
      argument.span,
      { help: errorHandlerSignatureHelp },
    );
    return undefined;
  };
  if (argument.kind !== "identifier-reference") {
    return invalid();
  }
  const target = applicationClassTargetOf(source, argument.entity, context.linker);
  if (target === undefined) {
    return definedHttpErrorTargetOf(source, argument.entity, context.linker) ?? invalid();
  }
  const handler = handlerForThrownClass(target, context);
  if (handler === undefined) {
    report(
      context.diagnostics,
      "THROWS_WITHOUT_HANDLER",
      `No registered error handler accepts ${target.name} (or one of its base classes).`,
      argument.span,
      {
        help:
          "Declare an @ErrorHandler() class whose handle method accepts this error class; " +
          "match-all handlers do not satisfy @Throws because the wire contract needs a status and body shape.",
        related: context.orderedHandlers.map((entry) => ({
          message: entry.beanId,
          sourceSpan: entry.span,
        })),
      },
    );
    return undefined;
  }
  return {
    kind: "handler",
    errorName: target.name,
    key: target.key,
    handlerBeanId: handler.beanId,
  };
}

// 路由 throws = 方法级 @Throws ∪ 挂载中间件类级 @Throws:按类键去重、errorName 排序(同名
// 异文件再按 key 决胜),manifest 与 explain 的顺序由此确定。
export function unionThrows(
  lists: readonly (readonly RouteThrownErrorModel[])[],
): readonly RouteThrownErrorModel[] {
  const byKey = new Map<string, RouteThrownErrorModel>();
  for (const item of lists.flat()) {
    if (!byKey.has(item.key)) {
      byKey.set(item.key, item);
    }
  }
  return [...byKey.values()].toSorted((left, right) => {
    const name = compareUtf16CodeUnits(left.errorName, right.errorName);
    return name === 0 ? compareUtf16CodeUnits(left.key, right.key) : name;
  });
}
