import { compareUtf16CodeUnits } from "@reforce/primitives";
import type { ProviderModel } from "@/analysis/model";
import { applicationClassTargetOf } from "@/analysis/web-class-target";
import { type ClassRoleScan, claimWebBean, singleCalledDecorator } from "@/analysis/web-decorators";
import {
  type MiddlewareMountModel,
  type RouteMiddlewareModel,
  type WebExportRefModel,
  type WebPhaseModel,
  webPhaseOrder,
  webPhaseRank,
} from "@/analysis/web-model";
import type { CompilerDiagnostic } from "@/api";
import { report } from "@/diagnostics";
import type { ProjectLinker } from "@/linking/project-linker";
import type {
  DecoratorArgumentValue,
  DecoratorUse,
  ObjectLiteralProperty,
} from "@/parser/source-ir";
import type { ParsedSource } from "@/project/source-files";

// 中间件的登记、@Use 解析与链压平（ADR 0006 W4；#363 独立成模块）：@Middleware 选项表、
// 挂载点解析，以及「全局 + 路由组 + 单路由」去重后按 (阶段, order, beanId) 写死的执行顺序。
//
// 挂载点只是成员资格与来源标注，执行顺序与挂载位置、书写顺序无关。
export interface MiddlewareInfo {
  readonly ref: WebExportRefModel;
  readonly beanId: string;
  readonly phase: WebPhaseModel;
  readonly order: number;
  readonly global: boolean;
  // 类级 @Throws 原始形态(#275):处理器名录建成后统一解析,挂载路由取并集。
  readonly throwsDecorators: readonly DecoratorUse[];
}

interface MiddlewareOptionsModel {
  readonly phase: WebPhaseModel;
  readonly order: number;
  readonly global: boolean;
}

function isWebPhaseModel(value: string): value is WebPhaseModel {
  return (webPhaseOrder as readonly string[]).includes(value);
}

// 选项键表驱动（超过 3 分支的分派按仓库纪律归一为 key → 解析器）：parse 返回 undefined 即
// 值形态非法，message 是对应的点名文案。
const middlewareOptionParsers = {
  phase: {
    message: `Middleware phase must be one of ${webPhaseOrder
      .map((phase) => JSON.stringify(phase))
      .join(", ")}.`,
    parse: (value: DecoratorArgumentValue, options: MiddlewareOptionsModel) =>
      value.kind === "string-literal" && isWebPhaseModel(value.value)
        ? { ...options, phase: value.value }
        : undefined,
  },
  order: {
    message: "Middleware order must be an integer literal.",
    parse: (value: DecoratorArgumentValue, options: MiddlewareOptionsModel) =>
      value.kind === "number-literal" && Number.isInteger(value.value)
        ? { ...options, order: value.value }
        : undefined,
  },
  global: {
    message: "Middleware global must be a boolean literal.",
    parse: (value: DecoratorArgumentValue, options: MiddlewareOptionsModel) =>
      value.kind === "boolean-literal" ? { ...options, global: value.value } : undefined,
  },
} as const;

function middlewareOptionOf(
  property: ObjectLiteralProperty,
  options: MiddlewareOptionsModel,
  diagnostics: CompilerDiagnostic[],
): MiddlewareOptionsModel | undefined {
  if (property.kind === "unsupported-property") {
    report(
      diagnostics,
      "INVALID_MIDDLEWARE_DECLARATION",
      `Middleware options cannot use ${property.propertyKind} properties.`,
      property.span,
    );
    return undefined;
  }
  if (!Object.hasOwn(middlewareOptionParsers, property.key)) {
    report(
      diagnostics,
      "INVALID_MIDDLEWARE_DECLARATION",
      `Middleware options do not include "${property.key}".`,
      property.span,
    );
    return undefined;
  }
  // Object.hasOwn 已证明成员资格，索引签名推不回字面量联合 // justified: 见上一行
  const parser = middlewareOptionParsers[property.key as keyof typeof middlewareOptionParsers];
  const parsed = parser.parse(property.value, options);
  if (parsed === undefined) {
    report(diagnostics, "INVALID_MIDDLEWARE_DECLARATION", parser.message, property.span);
    return undefined;
  }
  return parsed;
}

function middlewareOptionsOf(
  decorator: DecoratorUse,
  diagnostics: CompilerDiagnostic[],
): MiddlewareOptionsModel | undefined {
  const defaults: MiddlewareOptionsModel = { phase: "application", order: 0, global: false };
  const argument = decorator.arguments.at(0);
  if (argument === undefined) {
    return defaults;
  }
  if (decorator.arguments.length !== 1 || argument.kind !== "object-literal") {
    report(
      diagnostics,
      "INVALID_MIDDLEWARE_DECLARATION",
      "Middleware accepts one object literal of options.",
      argument.span,
    );
    return undefined;
  }
  let options: MiddlewareOptionsModel | undefined = defaults;
  for (const property of argument.properties) {
    options = middlewareOptionOf(property, options, diagnostics);
    if (options === undefined) {
      return undefined;
    }
  }
  return options;
}

function useTargetOf(
  source: ParsedSource,
  argument: DecoratorArgumentValue,
  middlewareById: ReadonlyMap<string, MiddlewareInfo>,
  linker: ProjectLinker,
): MiddlewareInfo | undefined {
  if (argument.kind !== "identifier-reference") {
    return undefined;
  }
  const target = applicationClassTargetOf(source, argument.entity, linker);
  return target === undefined ? undefined : middlewareById.get(target.key);
}

export function useTargetsOf(
  source: ParsedSource,
  decorators: readonly DecoratorUse[],
  middlewareById: ReadonlyMap<string, MiddlewareInfo>,
  linker: ProjectLinker,
  diagnostics: CompilerDiagnostic[],
): readonly MiddlewareInfo[] {
  const middleware: MiddlewareInfo[] = [];
  for (const decorator of decorators) {
    if (!decorator.called || decorator.arguments.length === 0) {
      report(
        diagnostics,
        "INVALID_MIDDLEWARE_DECLARATION",
        "Use requires at least one middleware class argument.",
        decorator.span,
      );
      continue;
    }
    for (const argument of decorator.arguments) {
      const info = useTargetOf(source, argument, middlewareById, linker);
      if (info === undefined) {
        report(
          diagnostics,
          "INVALID_MIDDLEWARE_DECLARATION",
          "Use only accepts application classes marked @Middleware().",
          argument.span,
        );
        continue;
      }
      middleware.push(info);
    }
  }
  return middleware;
}

// 链压平（ADR 0006 W4）：全局 + 路由组(@Use 于 controller) + 单路由(@Use 于 handler)，
// beanId 去重后按 (阶段, order, beanId) 排序写死。挂载点只是成员资格与来源标注，
// 执行顺序与挂载位置、书写顺序无关。
export function flattenedChain(
  globalMiddleware: readonly MiddlewareInfo[],
  controllerUse: readonly MiddlewareInfo[],
  routeUse: readonly MiddlewareInfo[],
): readonly RouteMiddlewareModel[] {
  const byBeanId = new Map<string, RouteMiddlewareModel>();
  const mounts: readonly (readonly [MiddlewareMountModel, readonly MiddlewareInfo[]])[] = [
    ["global", globalMiddleware],
    ["controller", controllerUse],
    ["route", routeUse],
  ];
  for (const [mount, entries] of mounts) {
    for (const entry of entries) {
      if (!byBeanId.has(entry.beanId)) {
        byBeanId.set(entry.beanId, {
          ref: entry.ref,
          beanId: entry.beanId,
          phase: entry.phase,
          order: entry.order,
          mount,
        });
      }
    }
  }
  return [...byBeanId.values()].toSorted((left, right) => {
    const phase = webPhaseRank(left.phase) - webPhaseRank(right.phase);
    if (phase !== 0) {
      return phase;
    }
    const order = left.order - right.order;
    return order === 0 ? compareUtf16CodeUnits(left.beanId, right.beanId) : order;
  });
}

export function registerMiddleware(
  scan: ClassRoleScan,
  providerById: ReadonlyMap<string, ProviderModel>,
  middlewareById: Map<string, MiddlewareInfo>,
  diagnostics: CompilerDiagnostic[],
): void {
  const decorator = singleCalledDecorator(
    "Middleware",
    scan.web.get("Middleware") ?? [],
    "INVALID_MIDDLEWARE_DECLARATION",
    diagnostics,
  );
  if (decorator === undefined) {
    return;
  }
  const claim = claimWebBean(
    scan.source,
    scan.declaration,
    "middleware",
    providerById,
    diagnostics,
  );
  const options = middlewareOptionsOf(decorator, diagnostics);
  if (claim !== undefined && options !== undefined) {
    middlewareById.set(claim.beanId, {
      ref: claim.ref,
      beanId: claim.beanId,
      phase: options.phase,
      order: options.order,
      global: options.global,
      throwsDecorators: scan.web.get("Throws") ?? [],
    });
  }
}
