import { type ProviderModel, providerId } from "@/analysis/model";
import type { CompilerDiagnostic, CompilerDiagnosticCode } from "@/api";
import { diagnostic } from "@/diagnostics";
import type { LinkedSymbol } from "@/linking/model";
import type { ClassDeclaration } from "@/parser/source-ir";
import type { SourceSpan } from "@/parser/source-location";
import type { ParsedSource } from "@/project/source-files";

// 角色 bean 的唯一事实源（修订 ADR 0006 W3 与 ADR 0008 AM1 的定案）：角色装饰器本身蕴含
// bean 身份，不再要求并列 @Injectable()——编译器既然知道得足够多到能命令你补一个零参数的
// @Injectable()，就知道得足够多到自己蕴含它。三条事实在这张表里各声明一次：
//   1. 角色装饰器就是 bean 声明入口（class-provider 读它决定要不要产 draft）；
//   2. 角色 bean 只能是 singleton（框架在启动期一次性解析它们）；
//   3. 角色 bean 不进按类型解析的候选集（resolve-providers 只读 provider.role）。
// 今天四行的策略完全相同，表的价值不在按角色分策略，而在这三条事实与登记逻辑各只有一份
// 实现——加第 5 个角色是加一行，不是抄第三份。
//
// 不提供公开的角色注册 API：linker 的符号 kind 由模块 specifier 决定（linking/export-binding.ts
// 里的三个框架字面量），第三方包拿不到 framework kind；starter meta v1 也没有角色槽位。
// 光加 API 打不通，要连着升 meta 版本，是另一个 RFC 的体量。
export type BeanRole = "controller" | "error-handler" | "interceptor" | "middleware";

interface BeanRoleSpec {
  readonly role: BeanRole;
  // 角色识别沿用现有机制：kind 由模块 specifier 决定，角色名按符号名字符串比对。
  readonly symbolKind: "core" | "web";
  readonly decorator: string;
  // 诊断文案里的角色名。
  readonly label: string;
  // 该角色的既有诊断码，登记失败与 scope 违规都用它，调用方因此不必各带一份。
  readonly code: CompilerDiagnosticCode;
  // "为什么只能 singleton" 的角色特定理由，拼进同一句拒绝文案。
  readonly singletonReason: string;
}

// 顺序即多角色场景下的决定性选择顺序：一类多角色本身是错误，由角色消费方点名，这里只需
// 保证选出的那个角色与源码书写顺序无关。
const beanRoleSpecs = [
  {
    role: "controller",
    symbolKind: "web",
    decorator: "Controller",
    label: "controller",
    code: "INVALID_ROUTE_DECLARATION",
    singletonReason:
      "a controller is resolved once at startup and reads request state through RequestContext or Current<T>",
  },
  {
    role: "middleware",
    symbolKind: "web",
    decorator: "Middleware",
    label: "middleware",
    code: "INVALID_ROUTE_DECLARATION",
    singletonReason:
      "a middleware is resolved once at startup and reads request state through RequestContext or Current<T>",
  },
  {
    role: "error-handler",
    symbolKind: "web",
    decorator: "ErrorHandler",
    label: "error handler",
    code: "INVALID_ROUTE_DECLARATION",
    singletonReason:
      "an error handler is resolved once at startup and reads request state through RequestContext or Current<T>",
  },
  {
    role: "interceptor",
    symbolKind: "core",
    decorator: "Interceptor",
    label: "interceptor",
    code: "INVALID_INTERCEPTOR_DECLARATION",
    singletonReason: "an interceptor is constructed with the Beans it weaves",
  },
] as const satisfies readonly BeanRoleSpec[];

export const beanRoles: readonly BeanRole[] = beanRoleSpecs.map((spec) => spec.role);

const specByRole = new Map<BeanRole, BeanRoleSpec>(
  beanRoleSpecs.map((spec) => [spec.role, spec] as const),
);

const specByDecorator = new Map<string, BeanRoleSpec>(
  beanRoleSpecs.map((spec) => [`${spec.symbolKind}\0${spec.decorator}`, spec] as const),
);

export function beanRoleSpecOf(role: BeanRole): BeanRoleSpec {
  const spec = specByRole.get(role);
  if (spec === undefined) {
    throw new Error(`Missing Bean role spec for ${role}`);
  }
  return spec;
}

export function beanRoleOfDecorator(symbol: LinkedSymbol | undefined): BeanRole | undefined {
  if (symbol === undefined) {
    return undefined;
  }
  return specByDecorator.get(`${symbol.kind}\0${symbol.name}`)?.role;
}

// 表驱动的决定性选择：多个角色装饰器同时出现是错误形态，由角色消费方点名（web 三角色的
// 互斥在 web-routes，跨框架组合由 claimRoleBean 的角色错配分支）。这里只保证 provider 上的
// role 与源码书写顺序无关。
export function soleBeanRoleOf(roles: ReadonlySet<BeanRole>): BeanRole | undefined {
  return beanRoleSpecs.find((spec) => roles.has(spec.role))?.role;
}

export function reportRoleRequestScope(
  role: BeanRole,
  className: string,
  span: SourceSpan,
  diagnostics: CompilerDiagnostic[],
): void {
  const spec = beanRoleSpecOf(role);
  diagnostics.push(
    diagnostic({
      code: spec.code,
      message: `${className} cannot be request-scoped: ${spec.singletonReason}.`,
      sourceSpan: span,
      help: `Keep the ${spec.label} singleton and read request state through RequestContext or Current<T>.`,
    }),
  );
}

export interface RoleBeanClaim {
  readonly beanId: string;
  readonly exportName: string;
}

// 角色 bean 认领：四个角色共用的登记入口。provider 表由 class-provider 产出，这里只回答
// "这个类是不是以这个角色登记的"。
//
// provider 缺席时保持沉默：analyzeClassProvider 的每条 undefined 返回都已在原位报过原因
// （非法导出形态、构造器形态、@Injectable 与角色装饰器共存、@RequestScoped 与角色共存），
// 再报一次只是重复点名。唯一会带着 provider 走到这里的错配形态是 config 类与一类多角色，
// 落到下面的 role 不匹配分支。
export function claimRoleBean(
  source: ParsedSource,
  declaration: ClassDeclaration,
  role: BeanRole,
  providerById: ReadonlyMap<string, ProviderModel>,
  diagnostics: CompilerDiagnostic[],
): RoleBeanClaim | undefined {
  const exportName = declaration.name;
  const provider =
    exportName === undefined ? undefined : providerById.get(providerId(source.fileId, exportName));
  if (provider === undefined || exportName === undefined) {
    return undefined;
  }
  if (provider.role === role) {
    return { beanId: provider.id, exportName };
  }
  const spec = beanRoleSpecOf(role);
  const played = provider.role === undefined ? undefined : beanRoleSpecOf(provider.role);
  diagnostics.push(
    diagnostic({
      code: spec.code,
      message:
        played === undefined
          ? `${exportName} does not play the ${spec.label} role.`
          : `${exportName} already plays the ${played.label} role: a class plays one framework role.`,
      sourceSpan: declaration.span,
      help: `Declare the ${spec.label} as its own exported class marked @${spec.decorator}().`,
    }),
  );
  return undefined;
}
