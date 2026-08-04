import type { GeneratedSourceReferenceModel } from "@/analysis/model";
import type { ParsedSource } from "@/project/source-files";

// web 面的分析模型（ADR 0006 W1/W3/W4/W5，#142 / #152）：路由表是编译器的第二种生成物，
// 这里的形状经 emission 双写为 routes.json（纯数据）与 routes.ts（可执行表）。方法与阶段
// 闭集同 @reforce/web 的运行时词汇（两侧都是封闭字面量联合，扩展必须同步）。

export type HttpMethodModel = "DELETE" | "GET" | "HEAD" | "OPTIONS" | "PATCH" | "POST" | "PUT";

// 阶段数组顺序即链上顺序（外→内）；压平排序 = (阶段序, order, beanId)。
export const webPhaseOrder = ["observability", "admission", "application"] as const;

export type WebPhaseModel = (typeof webPhaseOrder)[number];

export function webPhaseRank(phase: WebPhaseModel): number {
  return webPhaseOrder.indexOf(phase);
}

export type RouteMetaValueModel =
  | string
  | number
  | boolean
  | null
  | readonly RouteMetaValueModel[]
  | { readonly [key: string]: RouteMetaValueModel };

// 应用源集内某个具名导出值/类的坐标：emission 用它重建 routes.ts 的 import。
export interface WebExportRefModel {
  readonly source: ParsedSource;
  readonly exportName: string;
}

export type MiddlewareMountModel = "controller" | "global" | "route";

export interface RouteMiddlewareModel {
  readonly ref: WebExportRefModel;
  readonly beanId: string;
  readonly phase: WebPhaseModel;
  readonly order: number;
  readonly mount: MiddlewareMountModel;
}

export interface RouteSchemasModel {
  readonly params?: WebExportRefModel;
  readonly query?: WebExportRefModel;
  readonly body?: WebExportRefModel;
  readonly response?: WebExportRefModel;
}

export interface RouteModel {
  readonly method: HttpMethodModel;
  readonly path: string;
  readonly controller: WebExportRefModel;
  readonly controllerId: string;
  readonly handler: string;
  // emission 用它决定 invoke 闭包传不传 RequestContext：零参 handler 多传实参是 tsc 错误。
  readonly handlerArity: 0 | 1;
  readonly middleware: readonly RouteMiddlewareModel[];
  readonly meta: ReadonlyMap<string, RouteMetaValueModel>;
  readonly schemas: RouteSchemasModel;
  readonly source: GeneratedSourceReferenceModel;
}

export interface WebErrorHandlerModel {
  readonly ref: WebExportRefModel;
  readonly beanId: string;
  readonly order: number;
}

// 注册的 web 引擎 starter bean（ADR 0006 W2 的 #153 接线修订，约定记录于 #142/#152 评论区）：
// starter meta 中 runtimeExport 导出名为 "WebEngine" 的 bean 即引擎。生成的 bootstrap 按此
// import 引擎类、经容器取实例并交给 connectWebApplication，因此引擎 bean 无需 role:"root"——
// bootstrap 本身就是它的需求方（resolveProviders 据此物化）。
export interface WebEngineModel {
  readonly beanId: string;
  readonly moduleSpecifier: string;
  readonly exportName: string;
}

export interface WebModel {
  // 已按 (path, method) 决定性排序。
  readonly routes: readonly RouteModel[];
  // 已按 (order, beanId) 决定性排序，数组顺序即分派顺序。
  readonly errorHandlers: readonly WebErrorHandlerModel[];
  // 已按 beanId 决定性排序，数组顺序即引擎启动顺序（关闭时逆序）。
  readonly engines: readonly WebEngineModel[];
  // defineApplication 模块作用域内名为 webRequestSeeder 的顶层值（本地导出声明或一跳具名
  // import），生成的 bootstrap 把它交给 connectWebApplication 完成每请求播种；缺省不播种。
  readonly requestSeeder?: WebExportRefModel;
}

export const emptyWebModel: WebModel = Object.freeze({
  routes: Object.freeze([]),
  errorHandlers: Object.freeze([]),
  engines: Object.freeze([]),
});
