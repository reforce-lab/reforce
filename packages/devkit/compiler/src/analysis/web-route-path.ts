import { compareUtf16CodeUnits } from "@reforce/primitives";
import type { HttpMethodModel, RouteModel } from "@/analysis/web-model";
import type { CompilerDiagnostic } from "@/api";
import { report } from "@/diagnostics";
import type { ClassMethodDeclaration } from "@/parser/source-ir";
import type { SourceSpan } from "@/parser/source-location";

// 路由路径词汇与注册冲突（ADR 0006 W1；#363 独立成模块）：静态段 + :param 段的合法性、
// controller 前缀与方法子路径的归并、以及同 (方法, 路径 shape) 的重复注册硬错。
//
// routeDecoratorNames 必须与 routeMethodByDecorator 同文件：前者是后者键集的派生，分开放
// 就会出现「加了一个 HTTP 方法但装饰器名单没跟上」这类只能靠人记住的耦合。
export const routeMethodByDecorator = {
  Delete: "DELETE",
  Get: "GET",
  Head: "HEAD",
  Options: "OPTIONS",
  Patch: "PATCH",
  Post: "POST",
  Put: "PUT",
} as const satisfies Record<string, HttpMethodModel>;

export const routeDecoratorNames = new Set(Object.keys(routeMethodByDecorator));

const parameterSegmentPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

const literalSegmentPattern = /^[A-Za-z0-9._~-]+$/;

// 路径词汇（ADR 0006 W1）：静态段 + :param 段。冲突键把参数段归一为 ":"——同 shape 的两条
// 路由无论参数叫什么都是同一条注册。
interface RoutePathInfo {
  readonly path: string;
  readonly shapeKey: string;
  // 路径参数名集合(#274 硬错 6):Param 槽的键名必须都出现在这里。
  readonly parameters: ReadonlySet<string>;
}

export function normalizedPrefix(
  value: string,
  span: SourceSpan,
  diagnostics: CompilerDiagnostic[],
): string | undefined {
  if (value === "" || value === "/") {
    return "";
  }
  if (!value.startsWith("/")) {
    report(
      diagnostics,
      "INVALID_ROUTE_DECLARATION",
      `Route path ${JSON.stringify(value)} must start with "/".`,
      span,
    );
    return undefined;
  }
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function parameterSegmentShape(
  segment: string,
  path: string,
  parameters: Set<string>,
  span: SourceSpan,
  diagnostics: CompilerDiagnostic[],
): string | undefined {
  const name = segment.slice(1);
  if (!parameterSegmentPattern.test(name)) {
    report(
      diagnostics,
      "INVALID_ROUTE_DECLARATION",
      `Route parameter ${JSON.stringify(segment)} must be :name with a valid identifier.`,
      span,
    );
    return undefined;
  }
  if (parameters.has(name)) {
    report(
      diagnostics,
      "INVALID_ROUTE_DECLARATION",
      `Route path ${JSON.stringify(path)} declares parameter ${JSON.stringify(name)} twice.`,
      span,
    );
    return undefined;
  }
  parameters.add(name);
  return ":";
}

export function routePathOf(
  basePath: string,
  subPath: string,
  span: SourceSpan,
  diagnostics: CompilerDiagnostic[],
): RoutePathInfo | undefined {
  const joined = `${basePath}${subPath}`;
  const path = joined === "" ? "/" : joined;
  const segments = path === "/" ? [] : path.slice(1).split("/");
  const parameters = new Set<string>();
  const shapeSegments: string[] = [];
  for (const segment of segments) {
    if (segment.startsWith(":")) {
      const shape = parameterSegmentShape(segment, path, parameters, span, diagnostics);
      if (shape === undefined) {
        return undefined;
      }
      shapeSegments.push(shape);
      continue;
    }
    if (!literalSegmentPattern.test(segment)) {
      report(
        diagnostics,
        "INVALID_ROUTE_DECLARATION",
        `Route path segment ${JSON.stringify(segment)} is not supported.`,
        span,
        {
          help: "Use letters, digits, '.', '_', '~', '-' in static segments, or :name parameters.",
        },
      );
      return undefined;
    }
    shapeSegments.push(segment);
  }
  return { path, shapeKey: shapeSegments.join("/"), parameters };
}

// 参数列表形态不设上限(#274):逐参数合法性全部由槽位解析裁决。
export function validRouteHandlerMethod(
  method: ClassMethodDeclaration,
  controllerName: string,
  diagnostics: CompilerDiagnostic[],
): string | undefined {
  const name = method.name.kind === "identifier" ? method.name.name : undefined;
  if (
    name === undefined ||
    method.static ||
    method.accessibility !== "public" ||
    method.generator ||
    method.optional ||
    !method.implementation
  ) {
    report(
      diagnostics,
      "INVALID_ROUTE_DECLARATION",
      `Route handler on ${controllerName} must be a public instance method implementation with an identifier name.`,
      method.span,
    );
    return undefined;
  }
  return name;
}

export interface RouteCandidate {
  readonly route: RouteModel;
  readonly shapeKey: string;
  readonly span: SourceSpan;
  readonly fileId: string;
}

// 同路径同方法重复注册是硬错（ADR 0006 W1 / #152）：按 (fileId, offset) 决定性排序后，
// 后到者点名先到者（双侧定位，沿用 DUPLICATE_CONFIG_PREFIX 先例）。
export function reportRouteConflicts(
  candidates: readonly RouteCandidate[],
  diagnostics: CompilerDiagnostic[],
): readonly RouteModel[] {
  const ordered = candidates.toSorted((left, right) => {
    const file = compareUtf16CodeUnits(left.fileId, right.fileId);
    return file === 0 ? left.span.start.offset - right.span.start.offset : file;
  });
  const firstByKey = new Map<string, RouteCandidate>();
  const unique: RouteModel[] = [];
  for (const candidate of ordered) {
    const key = `${candidate.route.method} ${candidate.shapeKey}`;
    const first = firstByKey.get(key);
    if (first === undefined) {
      firstByKey.set(key, candidate);
      unique.push(candidate.route);
      continue;
    }
    report(
      diagnostics,
      "DUPLICATE_ROUTE",
      `Route ${candidate.route.method} ${candidate.route.path} is already registered by ${first.route.controllerId}#${first.route.handler}.`,
      candidate.span,
      {
        related: [
          {
            message: `${first.route.controllerId}#${first.route.handler}`,
            sourceSpan: first.span,
          },
        ],
        help: "Each method + path shape pair may be registered once; parameter names do not disambiguate.",
      },
    );
  }
  return unique;
}
