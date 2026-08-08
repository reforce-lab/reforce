import { type BeanRole, claimRoleBean } from "@/analysis/bean-roles";
import type { ProviderModel } from "@/analysis/model";
import type { WebExportRefModel } from "@/analysis/web-model";
import type { ResponseSchemaDirectiveModel, ResponseStatusModel } from "@/analysis/web-slots";
import type { CompilerDiagnostic } from "@/api";
import { report } from "@/diagnostics";
import type { ProjectLinker } from "@/linking/project-linker";
import type { ClassDeclaration, DecoratorUse } from "@/parser/source-ir";
import type { ParsedSource } from "@/project/source-files";

// web 装饰器的语法层读取（#363）：把 source-ir 上的装饰器数组翻成「按符号名分组的表」，
// 以及三件所有上层都要用的原子——单次调用校验、bean 认领、响应侧装饰器的字面量解析。
//
// 这里必须是中间件登记与错误处理器分析的**共同下游**，不能反过来：registerMiddleware 与
// registerErrorHandler 都要 singleCalledDecorator + claimWebBean + ClassRoleScan，把它们放进
// 任何一侧都会让另一侧 import 它，两个登记模块之间立刻成环。
// coreDecorators 的 web 版：按解析后的符号名分组，别名照样命中，非 web 装饰器留给别人。
export function webDecoratorsOf(
  source: ParsedSource,
  decorators: readonly DecoratorUse[],
  linker: ProjectLinker,
): ReadonlyMap<string, readonly DecoratorUse[]> {
  const result = new Map<string, DecoratorUse[]>();
  for (const decorator of decorators) {
    if (decorator.callee.kind === "unsupported-expression") {
      continue;
    }
    const symbol = linker.resolveEntity(source, decorator.callee);
    if (symbol?.kind !== "web") {
      continue;
    }
    const existing = result.get(symbol.name) ?? [];
    existing.push(decorator);
    result.set(symbol.name, existing);
  }
  return result;
}

export interface WebBeanClaim {
  readonly ref: WebExportRefModel;
  readonly beanId: string;
}

// controller/中间件/错误处理器的 bean 身份由各自的角色装饰器蕴含（bean-roles.ts）：身份、
// singleton 约束、@Injectable 共存拒绝都在 class-provider 一处判定，这里只把认领结果翻译成
// web 侧的引用形状。
export function claimWebBean(
  source: ParsedSource,
  declaration: ClassDeclaration,
  role: BeanRole,
  providerById: ReadonlyMap<string, ProviderModel>,
  diagnostics: CompilerDiagnostic[],
): WebBeanClaim | undefined {
  const claim = claimRoleBean(source, declaration, role, providerById, diagnostics);
  if (claim === undefined) {
    return undefined;
  }
  return { ref: { source, exportName: claim.exportName }, beanId: claim.beanId };
}

export function singleCalledDecorator(
  name: string,
  decorators: readonly DecoratorUse[],
  code: CompilerDiagnostic["code"],
  diagnostics: CompilerDiagnostic[],
): DecoratorUse | undefined {
  const first = decorators.at(0);
  if (first === undefined) {
    return undefined;
  }
  if (decorators.length !== 1 || !first.called) {
    report(diagnostics, code, `${name} must appear at most once as @${name}(...).`, first.span);
    return undefined;
  }
  return first;
}

interface ParsedResponseStatus {
  readonly status?: ResponseStatusModel;
  readonly failed: boolean;
}

// 不复用 metaValueOf:它的错误码/词表是路由 marker 的,且接受任意 JSON 树,这里恰要一个
// 100–599 的整数字面量。
export function responseStatusOf(
  decorators: readonly DecoratorUse[],
  diagnostics: CompilerDiagnostic[],
): ParsedResponseStatus {
  const decorator = singleCalledDecorator(
    "ResponseStatus",
    decorators,
    "INVALID_RESPONSE_STATUS",
    diagnostics,
  );
  if (decorator === undefined) {
    return { failed: decorators.length > 0 };
  }
  const argument = decorator.arguments.at(0);
  if (
    decorator.arguments.length !== 1 ||
    argument?.kind !== "number-literal" ||
    !Number.isInteger(argument.value) ||
    argument.value < 100 ||
    argument.value > 599
  ) {
    report(
      diagnostics,
      "INVALID_RESPONSE_STATUS",
      "ResponseStatus takes exactly one integer literal between 100 and 599.",
      argument?.span ?? decorator.span,
    );
    return { failed: true };
  }
  return { status: { value: argument.value, span: argument.span }, failed: false };
}

interface ParsedResponseSchema {
  readonly schema?: ResponseSchemaDirectiveModel;
  readonly failed: boolean;
}

export function responseSchemaOf(
  decorators: readonly DecoratorUse[],
  diagnostics: CompilerDiagnostic[],
): ParsedResponseSchema {
  const decorator = singleCalledDecorator(
    "ResponseSchema",
    decorators,
    "INVALID_RESPONSE_SCHEMA",
    diagnostics,
  );
  if (decorator === undefined) {
    return { failed: decorators.length > 0 };
  }
  const argument = decorator.arguments.at(0);
  if (decorator.arguments.length !== 1 || argument?.kind !== "identifier-reference") {
    report(
      diagnostics,
      "INVALID_RESPONSE_SCHEMA",
      "ResponseSchema takes exactly one reference to a Standard Schema value.",
      argument?.span ?? decorator.span,
    );
    return { failed: true };
  }
  return { schema: { entity: argument.entity, span: argument.span }, failed: false };
}

// ———— @Throws 解析与处理器匹配(#275) ————

export interface ClassRoleScan {
  readonly source: ParsedSource;
  readonly declaration: ClassDeclaration;
  readonly web: ReadonlyMap<string, readonly DecoratorUse[]>;
}

export function scanWebClasses(
  sources: readonly ParsedSource[],
  linker: ProjectLinker,
): readonly ClassRoleScan[] {
  const scans: ClassRoleScan[] = [];
  for (const source of sources) {
    if (source.sourceKind.startsWith("d.")) {
      continue;
    }
    for (const declaration of source.unit.classes) {
      const classLevel = webDecoratorsOf(source, declaration.decorators, linker);
      const anyMethodLevel = declaration.methods.some(
        (method) => webDecoratorsOf(source, method.decorators, linker).size > 0,
      );
      if (classLevel.size > 0 || anyMethodLevel) {
        scans.push({ source, declaration, web: classLevel });
      }
    }
  }
  return scans;
}
