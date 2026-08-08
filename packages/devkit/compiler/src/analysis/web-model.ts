import type { GeneratedSourceReferenceModel } from "@/analysis/model";
import type { ContractTable } from "@/analysis/type-contract";
import type { SourceSpan } from "@/parser/source-location";
import type { ParsedSource } from "@/project/source-files";

// web 面的分析模型（ADR 0006 W1/W3/W4/W5，#142 / #152）：路由表是编译器的第二种生成物，
// 这里的形状经 emission 双写为 routes.json（纯数据）与 routes.ts（可执行表）。方法与阶段
// 闭集同 @reforce/web-core 的运行时词汇（两侧都是封闭字面量联合，扩展必须同步）。

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

// 契约来源(RFC 0012 S2,#274):type = 编译器按类型生成解码器;schema = typeof 追溯命中的
// 用户 Standard Schema,routes.ts 按 ref 重新 import,解码交给它,vendor 落 routes.json。
export type ContractSourceModel =
  | { readonly source: "type" }
  | { readonly source: "schema"; readonly ref: WebExportRefModel; readonly vendor?: string };

// 槽位绑定模型(#274)。三字符串槽的 form:single = Param<"id",bigint> 单键;optional-single =
// 键名 ∪ undefined 或值类型含 undefined;contract = 对象契约整体解码。key 在单键形态是键名,
// 在契约形态是第四档投影键(解码仍按整契约跑,invoke 处按键投影)。
export interface StringRouteSlotModel {
  readonly kind: "param" | "query" | "header";
  readonly form: "single" | "optional-single" | "contract";
  readonly key?: string;
  readonly table: ContractTable;
  // schema 槽的线上侧字段表(#310):table 是 handler 侧(schema 输出),而请求线上侧的可缺省
  // 性以 ~standard.types.input 为准(如 zod default 的键请求可不带)。根字段 optional 合并
  // 输入侧后落 routes.json;typed-edge(routes.ts)仍用 table。两侧一致时缺省。
  readonly wireTable?: ContractTable;
  readonly contractSource: ContractSourceModel;
  readonly span: SourceSpan;
}

// Body 第一实参永远是契约(对象/数组/标量三种根,#264「定形」),不参与单键裁决。
export interface BodyRouteSlotModel {
  readonly kind: "body";
  readonly key?: string;
  readonly table: ContractTable;
  // 同 StringRouteSlotModel.wireTable(#310)。
  readonly wireTable?: ContractTable;
  readonly contractSource: ContractSourceModel;
  readonly span: SourceSpan;
}

export interface BareRouteSlotModel {
  readonly kind: "request" | "requestContext" | "responseHeaders";
  readonly span: SourceSpan;
}

export type RouteSlotModel = StringRouteSlotModel | BodyRouteSlotModel | BareRouteSlotModel;

// 响应侧三变体(RFC 0012 S3,#275):
// - table = 声明(返回类型/@ResponseSchema)或推导出的白名单契约,status 缺省 200;
// - free-form = 无声明且推导失败的降级——不投影不白名单,序列化原样出线;
// - passthrough = Response 逃生口(#264 决策 7,原样透传)/ void(运行时 204,status 可由
//   @ResponseStatus 覆盖)。
export type ResponseContractModel =
  | {
      readonly kind: "table";
      readonly table: ContractTable;
      readonly status: number;
      readonly contractSource: ContractSourceModel;
    }
  | { readonly kind: "free-form"; readonly status: number }
  | { readonly kind: "passthrough"; readonly status?: number };

export interface RouteContractModel {
  // 按 handler 参数序。
  readonly slots: readonly RouteSlotModel[];
  readonly response: ResponseContractModel;
}

// @Throws 声明的线上错误(#275/#310):路由方法与挂载中间件类的并集,已按类键去重、errorName
// 排序。两个变体:
// - handler = 应用错误类,状态码与 body 形状从 handlerBeanId 指向的类型化处理器读出
//   (manifest 装配时展开);
// - http-error = defineHttpError 造的 const,无处理器——运行时由框架兜底闭集直接翻译成
//   problem+json(status/code 取 defineHttpError 实参的静态字面量,非字面量时缺省)。
export type RouteThrownErrorModel =
  | {
      readonly kind: "handler";
      readonly errorName: string;
      // `${声明文件 fileId}#${类名}`:去重与决定性排序的身份键(http-error 变体同构,取 const 名)。
      readonly key: string;
      readonly handlerBeanId: string;
    }
  | {
      readonly kind: "http-error";
      readonly errorName: string;
      readonly key: string;
      readonly status?: number;
      readonly code?: string;
    };

export interface RouteModel {
  readonly method: HttpMethodModel;
  readonly path: string;
  readonly controller: WebExportRefModel;
  readonly controllerId: string;
  readonly handler: string;
  readonly middleware: readonly RouteMiddlewareModel[];
  readonly meta: ReadonlyMap<string, RouteMetaValueModel>;
  // 路由契约(#274):槽位与响应侧的唯一真相,emission 据它渲染 slots/invoke/encode。
  readonly contract: RouteContractModel;
  readonly throws: readonly RouteThrownErrorModel[];
  readonly source: GeneratedSourceReferenceModel;
}

// 类型化错误处理器的 accepts(#275):handle 参数 0 标注的项目错误类,运行时 instanceof 闸。
// ref 供 routes.ts 重新 import 类引用与 manifest 落坐标;key 与 RouteThrownErrorModel.key 同构。
export interface ErrorAcceptsModel {
  readonly ref: WebExportRefModel;
  readonly key: string;
  readonly name: string;
}

export interface WebErrorHandlerModel {
  readonly ref: WebExportRefModel;
  readonly beanId: string;
  readonly order: number;
  // 缺省 = match-all(handle(error: unknown) 或 field-form handle,S2 全部原样落这里)。
  readonly accepts?: ErrorAcceptsModel;
  // 处理器响应与路由同一模型:table/free-form 携带 @ResponseStatus 的状态码(缺则
  // ERROR_HANDLER_MISSING_STATUS 硬错),passthrough = 直返 Response。
  readonly response: ResponseContractModel;
}

// 引擎身份的判据（#228）：starter meta 的 provides 里出现 @reforce/web-core 的 WebEngineAdapter 契约。
// 判的是"实现了什么"而不是"叫什么名字"——曾经认 runtimeExport 导出名 "WebEngine"，命名不符
// 的引擎包会静默失败：bean 无需求方 → 不物化 → 连 manifest 都进不去，生成的 bootstrap 完全
// 不含 connectWebApplication，零诊断、routes.json 照常产出、应用能起、端口永不监听。
//
// 副作用要拿住：语义现在是"任何 provides WebEngineAdapter 的 starter bean 都是引擎"，
// 名字约定此前意外地兼着"只有一个引擎"的作用。多个引擎包同时注册会一起监听，无仲裁。
export const webPackageName = "@reforce/web-core";
export const webEngineAdapterName = "WebEngineAdapter";

// 注册的 web 引擎 starter bean（ADR 0006 W2 的 #153 接线修订，约定记录于 #142/#152 评论区）：
// 生成的 bootstrap 按此 import 引擎类、经容器取实例并交给 connectWebApplication，因此引擎
// bean 无需 role:"root"——bootstrap 本身就是它的需求方（resolveProviders 据此物化）。
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
