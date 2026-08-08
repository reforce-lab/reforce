import {
  type ContractShape,
  type ContractTable,
  expandTypeContract,
} from "@/analysis/type-contract";
import type {
  BareRouteSlotModel,
  BodyRouteSlotModel,
  ContractSourceModel,
  ResponseContractModel,
  RouteContractModel,
  RouteSlotModel,
  StringRouteSlotModel,
  WebExportRefModel,
} from "@/analysis/web-model";
import type { CompilerDiagnostic } from "@/api";
import { diagnostic } from "@/diagnostics";
import type {
  ClassMethodDeclaration,
  EntityName,
  MethodParameter,
  TypeNode,
} from "@/parser/source-ir";
import type { SourceSpan } from "@/parser/source-location";
import type { TypeQueryOf } from "@/typescript/type-query";

// 槽位解析(RFC 0012 S2,#264 决策 4/#274):路由 handler 的每个参数标注即 Web 契约。
// 分层原则:形态裁决(单键 vs 契约、六类硬错的 1/3/5/6、schema 语法追溯)全在语法层;
// 类型展开(契约合法性,硬错 2/4 的类型侧)全在 checker 层(expandTypeContract)。
// 全部签名按 TypeQueryOf<TType,TSymbol> 泛型化,checker 位置查询做成注入函数——单测用
// type-contract-stub 与内存映射钉全部分支,不起 tsgo。
//
// 槽位解析 per-method 只跑一次;仅硬错 6(路径参数比对)依赖每条路由的参数集,由
// reportUnknownPathParameters 按路由复裁(web-routes 调用)。

const allowedAnnotationsHelp =
  "Annotate each route handler parameter with Body<...>, Param<...>, Query<...>, Header<...>, " +
  "or one of the bare types Request, RequestContext, Headers from @reforce/web-core.";

// 标注头的符号身份,由 web-routes 经 linker 注入:web = @reforce/web-core 符号;global = 未被
// import/本地声明遮蔽的裸全局标识符(Request/Headers/Response/Promise 按 #264 附录实测
// 以全局名识别);other = 应用符号或解析不到的形态。
export type AnnotationHeadSymbol =
  | { readonly kind: "web"; readonly name: string }
  | { readonly kind: "global"; readonly name: string }
  | { readonly kind: "other" };

export interface SchemaTraceTarget<TType> {
  readonly ref: WebExportRefModel;
  // 值声明名位查到的类型;undefined = 文件不在 program / error type。
  readonly type: TType | undefined;
}

// schema 追溯的解析作用域:typeof 的值标识符与嵌套别名都要在"它们出现的模块"里解析——
// 别名右侧写在别名声明模块,不在 controller 模块。
export interface SchemaTraceScope<TType> {
  readonly aliasRhsOf: (name: EntityName) => AliasExpansion<TType> | undefined;
  readonly schemaTargetOf: (name: EntityName) => SchemaTraceTarget<TType> | undefined;
}

export interface AliasExpansion<TType> extends SchemaTraceScope<TType> {
  readonly rhs: TypeNode;
}

export interface SlotResolutionContext<TType, TSymbol> extends SchemaTraceScope<TType> {
  // undefined = checker 门面不可用。createCompiler 恒建会话,生产不可达;防御口径是
  // "需要查询时"才报 TYPE_CHECKER_UNAVAILABLE,纯裸槽位路由零查询不受影响。
  readonly query: TypeQueryOf<TType, TSymbol> | undefined;
  readonly fileIdOf: (declarationPath: string) => string | undefined;
  // 参数名位类型(S1 坑 2:注解位对 checker 恒答 error type,必须查名字位)。
  readonly typeAtParameter: (parameter: MethodParameter) => TType | undefined;
  // 方法名位的函数类型(响应侧经调用签名取返回类型)。
  readonly typeAtMethodName: () => TType | undefined;
  readonly headSymbolOf: (name: EntityName) => AnnotationHeadSymbol;
  // 投影形态(Param<Contract, "key">):契约声明名位的类型。实测(#274)类型实参标识符位
  // 查不到类型,整契约只能从声明位取,因此投影要求第一实参是可静态解析的命名契约。
  readonly contractDeclarationTypeOf: (
    reference: Extract<TypeNode, { readonly kind: "reference" }>,
  ) => TType | undefined;
  readonly diagnostics: CompilerDiagnostic[];
}

const webSlotNames = {
  Body: "body",
  Param: "param",
  Query: "query",
  Header: "header",
} as const satisfies Record<string, "body" | "param" | "query" | "header">;

type DataSlotKind = (typeof webSlotNames)[keyof typeof webSlotNames];
type StringSlotKind = Exclude<DataSlotKind, "body">;

function entityText(entity: EntityName): string {
  return entity.kind === "identifier" ? entity.name : `${entityText(entity.left)}.${entity.right}`;
}

export function leftmostIdentifier(entity: EntityName): string {
  return entity.kind === "identifier" ? entity.name : leftmostIdentifier(entity.left);
}

// ———— 形态裁决(语法层) ————

type StringSlotShape =
  | { readonly form: "single" | "optional-single"; readonly key: string }
  | { readonly form: "contract" }
  | { readonly form: "bare-string" }
  | { readonly form: "bare-scalar"; readonly scalar: "number" | "bigint" | "boolean" }
  | { readonly form: "literal-union" }
  | { readonly form: "invalid" };

function unionSlotShapeOf(members: readonly TypeNode[]): StringSlotShape {
  const literals = members.filter((member) => member.kind === "string-literal");
  const undefineds = members.filter(
    (member) => member.kind === "primitive" && member.name === "undefined",
  );
  if (literals.length + undefineds.length === members.length) {
    const first = literals[0];
    if (literals.length === 1 && first !== undefined && undefineds.length > 0) {
      return { form: "optional-single", key: first.value };
    }
    if (literals.length >= 2) {
      return { form: "literal-union" };
    }
    return { form: "invalid" };
  }
  // 掺了字面量的混合联合按字面量误用裁(硬错 3);纯非字面量联合交给契约展开。
  return literals.length > 0 ? { form: "literal-union" } : { form: "contract" };
}

// 三字符串槽第一实参的形态裁决(硬错 1/2/3 的语法侧)。
export function stringSlotShapeOf(argument: TypeNode): StringSlotShape {
  if (argument.kind === "string-literal") {
    return { form: "single", key: argument.value };
  }
  if (argument.kind === "union") {
    return unionSlotShapeOf(argument.members);
  }
  if (argument.kind === "primitive") {
    if (argument.name === "string") {
      return { form: "bare-string" };
    }
    if (argument.name === "number" || argument.name === "bigint" || argument.name === "boolean") {
      return { form: "bare-scalar", scalar: argument.name };
    }
    return { form: "invalid" };
  }
  return { form: "contract" };
}

// ———— schema 追溯(语法层) ————

interface SchemaQueryHit<TType> {
  readonly entity: EntityName;
  readonly span: SourceSpan;
  readonly scope: SchemaTraceScope<TType>;
}

// 追溯深度上限:别名可以层层嵌套,循环别名(A ↔ B)没有稳定的展开身份可去重,用深度封顶。
const aliasFollowLimit = 16;

// 在第一实参类型树里找 typeof(七种追溯形态的语法走查):reference 先走类型实参,零实参的
// reference 再跟非泛型别名右侧(存档例子全部以 type X = ... 别名给出,跟别名是常态);找到的
// typeof 连同"它出现的模块作用域"一起返回。
export function findSchemaTypeQuery<TType>(
  node: TypeNode,
  scope: SchemaTraceScope<TType>,
  depth = 0,
): SchemaQueryHit<TType> | undefined {
  if (depth > aliasFollowLimit) {
    return undefined;
  }
  if (node.kind === "type-query") {
    return { entity: node.name, span: node.span, scope };
  }
  if (node.kind === "reference") {
    const inArguments = findInChildren(node.typeArguments, scope, depth);
    if (inArguments !== undefined || node.typeArguments.length > 0) {
      return inArguments;
    }
    const expansion = scope.aliasRhsOf(node.name);
    return expansion === undefined
      ? undefined
      : findSchemaTypeQuery(expansion.rhs, expansion, depth + 1);
  }
  if (node.kind === "union") {
    return findInChildren(node.members, scope, depth);
  }
  if (node.kind === "array") {
    return findSchemaTypeQuery(node.element, scope, depth + 1);
  }
  return undefined;
}

function findInChildren<TType>(
  nodes: readonly TypeNode[],
  scope: SchemaTraceScope<TType>,
  depth: number,
): SchemaQueryHit<TType> | undefined {
  for (const child of nodes) {
    const hit = findSchemaTypeQuery(child, scope, depth + 1);
    if (hit !== undefined) {
      return hit;
    }
  }
  return undefined;
}

// ———— 契约表的形状校验(checker 层产物上的槽位差异裁决) ————

function rootShapeOf(table: {
  readonly root: ContractShape;
  readonly definitions: Readonly<Record<string, { readonly shape: ContractShape }>>;
}): ContractShape {
  return table.root.kind === "reference"
    ? (table.definitions[table.root.target]?.shape ?? table.root)
    : table.root;
}

function scalarValueError(shape: ContractShape, kind: string): string | undefined {
  if (shape.nullable) {
    return `${kind} single-key values cannot include null.`;
  }
  if (shape.kind === "scalar") {
    return shape.scalar === "null" ? `${kind} single-key values cannot be null.` : undefined;
  }
  if (shape.kind === "literal") {
    return undefined;
  }
  return `${kind} single-key values must be scalars or literal unions.`;
}

// 单键值类型合法集合:标量 / 字面量联合 / 标量数组(仅 Query)/ 以上 ∪ undefined(可选,
// 已在展开时剥掉)。
function singleValueShapeError(shape: ContractShape, slot: StringSlotKind): string | undefined {
  if (shape.kind === "array") {
    if (slot !== "query") {
      return `${slotDisplay[slot]} single-key values cannot be arrays; only Query keys repeat.`;
    }
    if (shape.nullable) {
      return "Query single-key array values cannot include null.";
    }
    return scalarValueError(shape.element, slotDisplay.query);
  }
  const error = scalarValueError(shape, slotDisplay[slot]);
  if (
    error !== undefined &&
    (shape.kind === "object" || shape.kind === "reference" || shape.kind === "union")
  ) {
    return `${slotDisplay[slot]} single-key values must be scalars, literal unions, or (Query only) scalar arrays.`;
  }
  return error;
}

const slotDisplay = {
  body: "Body",
  param: "Param",
  query: "Query",
  header: "Header",
} as const satisfies Record<DataSlotKind, string>;

// 三字符串槽契约字段的合法形状:载体是扁平字符串表,字段只能是标量/字面量联合/(仅 Query)
// 标量数组;嵌套对象、判别联合与引用都解不出来。
function contractFieldShapeError(
  fieldName: string,
  shape: ContractShape,
  slot: StringSlotKind,
): string | undefined {
  if (shape.kind === "array") {
    if (slot !== "query") {
      return `field \`${fieldName}\` is an array; only Query contracts may declare repeated keys.`;
    }
    const elementError = scalarValueError(shape.element, slotDisplay.query);
    return elementError === undefined
      ? undefined
      : `field \`${fieldName}\` has an unsupported array element; use scalars or literal unions.`;
  }
  if (shape.kind === "object" || shape.kind === "reference" || shape.kind === "union") {
    return `field \`${fieldName}\` is a nested structure; ${slotDisplay[slot]} decodes from a flat string carrier.`;
  }
  return scalarValueError(shape, slotDisplay[slot]) === undefined
    ? undefined
    : `field \`${fieldName}\` must be a scalar or literal union.`;
}

// ———— 主流程 ————

interface DataSlotState {
  contract?: SourceSpan;
  readonly singles: Map<string, SourceSpan>;
}

interface SlotAccumulator {
  readonly slots: RouteSlotModel[];
  // 每数据槽的占用状态:契约形态至多一个,且不与单键混用(硬错 4);单键同键至多一次(硬错 5)。
  readonly dataSlots: Map<DataSlotKind, DataSlotState>;
  readonly bareSlots: Map<"request" | "requestContext" | "responseHeaders", SourceSpan>;
  failed: boolean;
}

export interface ResolveRouteSlotsInputs<TType, TSymbol> {
  readonly method: ClassMethodDeclaration;
  readonly controllerName: string;
  readonly context: SlotResolutionContext<TType, TSymbol>;
  // @ResponseStatus / @ResponseSchema 的语法层解析产物(web-routes 提供);缺省两者皆无。
  readonly responseDirectives?: ResponseDirectives;
}

export function resolveRouteSlots<TType, TSymbol>(
  inputs: ResolveRouteSlotsInputs<TType, TSymbol>,
): RouteContractModel | undefined {
  const accumulator: SlotAccumulator = {
    slots: [],
    dataSlots: new Map(),
    bareSlots: new Map(),
    failed: false,
  };
  for (const parameter of inputs.method.parameters) {
    const slot = resolveParameterSlot(inputs, parameter);
    if (slot === undefined) {
      accumulator.failed = true;
      continue;
    }
    registerSlot(accumulator, slot, inputs.context.diagnostics);
  }
  const response = resolveResponseDeclaration({
    context: inputs.context,
    subject: `${inputs.controllerName}#${methodNameOf(inputs.method)}`,
    annotation: inputs.method.returnType,
    anchorSpan: inputs.method.returnType?.span ?? inputs.method.span,
    directives: inputs.responseDirectives ?? {},
    role: "route",
  });
  if (accumulator.failed || response === undefined) {
    return undefined;
  }
  return { slots: accumulator.slots, response };
}

function report(
  diagnostics: CompilerDiagnostic[],
  code: CompilerDiagnostic["code"],
  message: string,
  span: SourceSpan,
  options: {
    readonly help?: string;
    readonly related?: CompilerDiagnostic["related"];
    readonly suggestions?: CompilerDiagnostic["suggestions"];
  } = {},
): undefined {
  diagnostics.push(
    diagnostic({
      code,
      message,
      sourceSpan: span,
      help: options.help,
      related: options.related,
      suggestions: options.suggestions,
    }),
  );
  return undefined;
}

function isBareSlot(slot: RouteSlotModel): slot is BareRouteSlotModel {
  return (
    slot.kind === "request" || slot.kind === "requestContext" || slot.kind === "responseHeaders"
  );
}

function registerSlot(
  accumulator: SlotAccumulator,
  slot: RouteSlotModel,
  diagnostics: CompilerDiagnostic[],
): void {
  if (isBareSlot(slot)) {
    const first = accumulator.bareSlots.get(slot.kind);
    if (first !== undefined) {
      accumulator.failed = true;
      report(
        diagnostics,
        "DUPLICATE_SLOT_BINDING",
        `A route handler can bind ${slot.kind} at most once.`,
        slot.span,
        { related: [{ message: "first binding", sourceSpan: first }] },
      );
      return;
    }
    accumulator.bareSlots.set(slot.kind, slot.span);
    accumulator.slots.push(slot);
    return;
  }
  registerDataSlot(accumulator, slot, diagnostics);
}

function registerDataSlot(
  accumulator: SlotAccumulator,
  slot: BodyRouteSlotModel | StringRouteSlotModel,
  diagnostics: CompilerDiagnostic[],
): void {
  const state: DataSlotState = accumulator.dataSlots.get(slot.kind) ?? { singles: new Map() };
  const display = slotDisplay[slot.kind];
  const isContractForm = slot.kind === "body" || slot.form === "contract";
  if (isContractForm) {
    const conflict = state.contract ?? state.singles.values().next().value;
    if (conflict !== undefined) {
      accumulator.failed = true;
      report(
        diagnostics,
        "CONFLICTING_SLOT_CONTRACT",
        `${display} already has a binding on this handler; a slot takes one contract, or single keys, never both.`,
        slot.span,
        { related: [{ message: "existing binding", sourceSpan: conflict }] },
      );
      return;
    }
    accumulator.dataSlots.set(slot.kind, { ...state, contract: slot.span });
    accumulator.slots.push(slot);
    return;
  }
  if (state.contract !== undefined) {
    accumulator.failed = true;
    report(
      diagnostics,
      "CONFLICTING_SLOT_CONTRACT",
      `${display} already binds a contract on this handler; mixing contract and single-key forms is not supported.`,
      slot.span,
      { related: [{ message: "contract binding", sourceSpan: state.contract }] },
    );
    return;
  }
  const key = slot.key ?? "";
  const duplicate = state.singles.get(key);
  if (duplicate !== undefined) {
    accumulator.failed = true;
    report(
      diagnostics,
      "DUPLICATE_SLOT_BINDING",
      `${display} key ${JSON.stringify(key)} is already bound on this handler.`,
      slot.span,
      { related: [{ message: "first binding", sourceSpan: duplicate }] },
    );
    return;
  }
  state.singles.set(key, slot.span);
  accumulator.dataSlots.set(slot.kind, state);
  accumulator.slots.push(slot);
}

function resolveParameterSlot<TType, TSymbol>(
  inputs: ResolveRouteSlotsInputs<TType, TSymbol>,
  parameter: MethodParameter,
): RouteSlotModel | undefined {
  const { context } = inputs;
  const invalid = (detail: string): undefined =>
    report(
      context.diagnostics,
      "INVALID_SLOT_ANNOTATION",
      `Route handler parameter ${parameter.index} on ${inputs.controllerName} ${detail}`,
      parameter.span,
      { help: allowedAnnotationsHelp },
    );
  const shapeError = parameterShapeError(parameter);
  if (shapeError !== undefined) {
    return invalid(shapeError);
  }
  const annotation = parameter.typeAnnotation;
  if (annotation?.kind !== "reference") {
    return invalid(
      annotation === undefined ? "has no type annotation." : "is not a slot annotation.",
    );
  }
  const head = context.headSymbolOf(annotation.name);
  if (head.kind === "web" && Object.hasOwn(webSlotNames, head.name)) {
    // Object.hasOwn 已证明成员资格，索引签名推不回字面量联合 // justified: 见上一行
    const slot = webSlotNames[head.name as keyof typeof webSlotNames];
    return resolveDataSlot(inputs, parameter, annotation, slot);
  }
  if (head.kind === "web" && head.name === "RequestContext") {
    if (annotation.typeArguments.length > 0) {
      return invalid(
        "uses a generic RequestContext; the slot form takes the bare RequestContext type.",
      );
    }
    return { kind: "requestContext", span: parameter.span };
  }
  const bare = bareGlobalSlotOf(head, annotation, parameter.span);
  if (bare !== undefined) {
    return bare;
  }
  return invalid(
    `is annotated with ${entityText(annotation.name)}, which is not in the allowed set.`,
  );
}

// 解构/rest/无标注/可选参数在语法层即出局(#274「解析不出的参数」口径)。
function parameterShapeError(parameter: MethodParameter): string | undefined {
  if (parameter.rest) {
    return "is a rest parameter, which cannot bind a slot.";
  }
  if (parameter.name === undefined) {
    return "is a destructuring pattern; bind a slot to a plain identifier instead.";
  }
  if (parameter.optional || parameter.hasInitializer) {
    return 'uses `?` or an initializer; declare optionality in the slot type instead (e.g. Header<"x" | undefined>).';
  }
  return undefined;
}

function bareGlobalSlotOf(
  head: AnnotationHeadSymbol,
  annotation: Extract<TypeNode, { readonly kind: "reference" }>,
  span: SourceSpan,
): RouteSlotModel | undefined {
  if (head.kind !== "global" || annotation.typeArguments.length > 0) {
    return undefined;
  }
  if (head.name === "Request") {
    return { kind: "request", span };
  }
  if (head.name === "Headers") {
    return { kind: "responseHeaders", span };
  }
  return undefined;
}

function projectionKeyOf(
  argument: TypeNode | undefined,
  slot: DataSlotKind,
  diagnostics: CompilerDiagnostic[],
): { readonly key?: string; readonly failed: boolean } {
  if (argument === undefined) {
    return { failed: false };
  }
  if (argument.kind === "string-literal") {
    return { key: argument.value, failed: false };
  }
  report(
    diagnostics,
    "INVALID_SLOT_CONTRACT",
    `${slotDisplay[slot]} contract projection takes a string literal field name as its second type argument.`,
    argument.span,
  );
  return { failed: true };
}

// 需要 checker 查询时的统一守门:门面缺失报 TYPE_CHECKER_UNAVAILABLE(防御性,createCompiler
// 恒建会话,生产不可达),error type 报"先修 TS 错误"。
function requireType<TType, TSymbol>(
  context: SlotResolutionContext<TType, TSymbol>,
  type: TType | undefined,
  span: SourceSpan,
  what: string,
): TType | undefined {
  if (context.query === undefined) {
    return report(
      context.diagnostics,
      "TYPE_CHECKER_UNAVAILABLE",
      `${what} needs the TypeScript checker, which is unavailable for this compilation.`,
      span,
      { help: "Re-run the compilation; the checker session is rebuilt automatically." },
    );
  }
  if (type === undefined) {
    return report(
      context.diagnostics,
      "INVALID_SLOT_CONTRACT",
      `${what} has no computable type; fix TypeScript errors on the declaration first.`,
      span,
    );
  }
  return type;
}

function contractSourceOf<TType, TSymbol>(
  context: SlotResolutionContext<TType, TSymbol>,
  firstArgument: TypeNode,
  slot: DataSlotKind,
): {
  readonly source?: ContractSourceModel;
  // schema 命中时的 schema 值类型:wireTableOf 要拿它问 ~standard.types.input(#310)。
  readonly schemaType?: TType;
  readonly failed: boolean;
} {
  const hit = findSchemaTypeQuery(firstArgument, context);
  if (hit === undefined) {
    return { source: { source: "type" }, failed: false };
  }
  const target = hit.scope.schemaTargetOf(hit.entity);
  if (target === undefined) {
    report(
      context.diagnostics,
      "INVALID_SLOT_SCHEMA",
      `Cannot statically resolve schema value ${leftmostIdentifier(hit.entity)} referenced by the ${slotDisplay[slot]} contract.`,
      hit.span,
      {
        help: "Reference a top-level exported const from an application module; re-export chains are not supported.",
      },
    );
    return { failed: true };
  }
  const valueType = requireType(context, target.type, hit.span, "The schema value");
  if (valueType === undefined) {
    return { failed: true };
  }
  const standard = standardSchemaVendorOf(context, valueType);
  if (!standard.isStandard) {
    report(
      context.diagnostics,
      "INVALID_SLOT_SCHEMA",
      `Schema value ${leftmostIdentifier(hit.entity)} does not implement Standard Schema (missing ~standard.validate).`,
      hit.span,
      { help: "Use a Standard Schema v1 library export (zod, valibot, arktype, ...)." },
    );
    return { failed: true };
  }
  return {
    source: {
      source: "schema",
      ref: target.ref,
      ...(standard.vendor === undefined ? {} : { vendor: standard.vendor }),
    },
    schemaType: valueType,
    failed: false,
  };
}

// schema 槽的线上侧可缺省合并(#310):字段表来自槽位注解类型(schema 输出侧,如 z.infer),
// 但「请求里能不能缺这个键」由 ~standard.types.input 决定——zod 的 .default() 输出侧永远
// 有值、输入侧可缺省,照输出侧落盘会让 OpenAPI 把可缺省参数标成必填。这里只合并根对象
// 字段的 optional:输入侧属性可选性经 isOptionalProperty 查询,coerce 一类输入侧类型是
// unknown 也不影响属性位的可选性;嵌套层维持输出侧。根是命名引用时内联成对象根、不动
// definitions——同 key 定义在 OpenAPI 组件装配里是 first-wins,内容分叉会静默丢一份。
// 两侧一致时返回 undefined,emission 落原表。
function wireTableOf<TType, TSymbol>(
  context: SlotResolutionContext<TType, TSymbol>,
  schemaType: TType,
  table: ContractTable,
): ContractTable | undefined {
  const query = context.query;
  if (query === undefined) {
    return undefined;
  }
  const inputType = standardSchemaInputTypeOf(context, schemaType);
  if (inputType === undefined) {
    return undefined;
  }
  const root = resolvedRootObjectOf(table);
  if (root === undefined) {
    return undefined;
  }
  const inputOptionalByName = new Map(
    query
      .getPropertiesOfType(inputType)
      .map((symbol) => [query.symbolNameOf(symbol), query.isOptionalProperty(symbol)]),
  );
  let changed = false;
  const fields = root.shape.fields.map((field) => {
    const inputOptional = inputOptionalByName.get(field.name);
    if (inputOptional === undefined || inputOptional === field.optional) {
      return field;
    }
    changed = true;
    return { ...field, optional: inputOptional };
  });
  if (!changed) {
    return undefined;
  }
  const wireRoot: ContractShape = { kind: "object", fields, nullable: root.nullable };
  return { root: wireRoot, definitions: reachableDefinitionsOf(wireRoot, table.definitions) };
}

// 内联根后按可达性收缩 definitions(#310):被内联替换的命名定义若已无字段引用,留在表里会
// 以输出侧的旧 optional 进 OpenAPI components,与内联后的 wire 根自相矛盾。
function reachableDefinitionsOf(
  root: ContractShape,
  definitions: ContractTable["definitions"],
): ContractTable["definitions"] {
  const reachable: Record<string, ContractTable["definitions"][string]> = {};
  const pending: ContractShape[] = [root];
  while (pending.length > 0) {
    const shape = pending.pop();
    if (shape === undefined) {
      continue;
    }
    switch (shape.kind) {
      case "object":
        pending.push(...shape.fields.map((field) => field.shape));
        break;
      case "array":
        pending.push(shape.element);
        break;
      case "union":
        pending.push(...shape.members.map((member) => member.shape));
        break;
      case "reference": {
        const definition = definitions[shape.target];
        if (definition !== undefined && !(shape.target in reachable)) {
          reachable[shape.target] = definition;
          pending.push(definition.shape);
        }
        break;
      }
      default:
        break;
    }
  }
  return reachable;
}

// 根形态解引用(带环守卫):返回对象根与「引用位累计的 nullable」,非对象根返回 undefined。
function resolvedRootObjectOf(table: ContractTable):
  | {
      readonly shape: Extract<ContractShape, { readonly kind: "object" }>;
      readonly nullable: boolean;
    }
  | undefined {
  let current = table.root;
  let nullable = false;
  const seen = new Set<string>();
  while (current.kind === "reference") {
    if (seen.has(current.target)) {
      return undefined;
    }
    seen.add(current.target);
    nullable ||= current.nullable;
    const definition = table.definitions[current.target];
    if (definition === undefined) {
      return undefined;
    }
    current = definition.shape;
  }
  if (current.kind !== "object") {
    return undefined;
  }
  return { shape: current, nullable: nullable || current.nullable };
}

function standardSchemaVendorOf<TType, TSymbol>(
  context: SlotResolutionContext<TType, TSymbol>,
  valueType: TType,
): { readonly isStandard: boolean; readonly vendor?: string } {
  const query = context.query;
  if (query === undefined) {
    return { isStandard: false };
  }
  const properties = query.getPropertiesOfType(valueType);
  const standardSymbol = properties.find((symbol) => query.symbolNameOf(symbol) === "~standard");
  if (standardSymbol === undefined) {
    return { isStandard: false };
  }
  const standardType = query.getTypesOfSymbols([standardSymbol])[0];
  if (standardType === undefined) {
    return { isStandard: false };
  }
  const members = query.getPropertiesOfType(standardType);
  const names = new Set(members.map((symbol) => query.symbolNameOf(symbol)));
  if (!names.has("version") || !names.has("vendor") || !names.has("validate")) {
    return { isStandard: false };
  }
  const vendorSymbol = members.find((symbol) => query.symbolNameOf(symbol) === "vendor");
  const vendorType =
    vendorSymbol === undefined ? undefined : query.getTypesOfSymbols([vendorSymbol])[0];
  const literal = vendorType === undefined ? undefined : query.literalOf(vendorType);
  return {
    isStandard: true,
    ...(literal?.kind === "string" ? { vendor: literal.value } : {}),
  };
}

function expandContract<TType, TSymbol>(
  context: SlotResolutionContext<TType, TSymbol>,
  type: TType,
  span: SourceSpan,
  allowUndefinedRoot: boolean,
  // 推导模式(S3,#275)把诊断引流进局部数组:失败即静默降级 free-form,不见诸公开诊断。
  sink?: CompilerDiagnostic[],
): { readonly table?: ContractTable; readonly optional: boolean } {
  const query = context.query;
  if (query === undefined) {
    // requireType 已在取类型时守门;这里不可达,防御返回失败。
    return { optional: false };
  }
  const result = expandTypeContract({
    type,
    span,
    query,
    fileIdOf: context.fileIdOf,
    allowUndefinedRoot,
  });
  (sink ?? context.diagnostics).push(...result.diagnostics);
  return { table: result.table, optional: result.rootStrippedUndefined };
}

function resolveDataSlot<TType, TSymbol>(
  inputs: ResolveRouteSlotsInputs<TType, TSymbol>,
  parameter: MethodParameter,
  annotation: Extract<TypeNode, { readonly kind: "reference" }>,
  slot: DataSlotKind,
): RouteSlotModel | undefined {
  const { context } = inputs;
  const firstArgument = annotation.typeArguments[0];
  if (firstArgument === undefined) {
    return report(
      context.diagnostics,
      "INVALID_SLOT_CONTRACT",
      `${slotDisplay[slot]} requires a type argument.`,
      annotation.span,
    );
  }
  if (slot === "body") {
    return resolveContractSlot(inputs, parameter, annotation, slot, firstArgument);
  }
  const shape = stringSlotShapeOf(firstArgument);
  switch (shape.form) {
    case "single":
    case "optional-single":
      return resolveSingleSlot(
        inputs,
        parameter,
        slot,
        shape.key,
        shape.form === "optional-single",
      );
    case "contract":
      return resolveContractSlot(inputs, parameter, annotation, slot, firstArgument);
    case "bare-string":
      return report(
        context.diagnostics,
        "INVALID_SLOT_KEY",
        `${slotDisplay[slot]} cannot take bare \`string\` as a key; name the key with a string literal.`,
        firstArgument.span,
        {
          help: `Write ${entityText(annotation.name)}<"${parameter.name ?? "key"}"> to bind one key.`,
        },
      );
    case "literal-union":
      return report(
        context.diagnostics,
        "INVALID_SLOT_KEY",
        `${slotDisplay[slot]} takes exactly one string literal key; a literal union does not name a single key.`,
        firstArgument.span,
        { help: "Bind each key with its own parameter, or declare a contract type." },
      );
    case "bare-scalar":
      return report(
        context.diagnostics,
        "INVALID_SLOT_CONTRACT",
        `${slotDisplay[slot]} cannot take bare \`${shape.scalar}\` as a contract; single keys name the key first.`,
        annotation.span,
        {
          suggestions: [
            {
              message: `Bind the ${JSON.stringify(parameter.name ?? "key")} key with a ${shape.scalar} value.`,
              span: annotation.span,
              replacement: `${entityText(annotation.name)}<"${parameter.name ?? "key"}", ${shape.scalar}>`,
              applicability: "machine-applicable",
            },
          ],
        },
      );
    case "invalid":
      return report(
        context.diagnostics,
        "INVALID_SLOT_CONTRACT",
        `${slotDisplay[slot]} has an unsupported first type argument.`,
        firstArgument.span,
      );
  }
}

function resolveSingleSlot<TType, TSymbol>(
  inputs: ResolveRouteSlotsInputs<TType, TSymbol>,
  parameter: MethodParameter,
  slot: StringSlotKind,
  key: string,
  syntacticallyOptional: boolean,
): RouteSlotModel | undefined {
  const { context } = inputs;
  const location = `Route handler parameter ${parameter.index} on ${inputs.controllerName}`;
  const valueType = requireType(
    context,
    context.typeAtParameter(parameter),
    parameter.span,
    location,
  );
  if (valueType === undefined) {
    return undefined;
  }
  const expanded = expandContract(context, valueType, parameter.span, true);
  if (expanded.table === undefined) {
    return undefined;
  }
  const shapeError = singleValueShapeError(rootShapeOf(expanded.table), slot);
  if (shapeError !== undefined) {
    return report(
      context.diagnostics,
      "INVALID_SLOT_CONTRACT",
      `${location}: ${shapeError}`,
      parameter.span,
    );
  }
  return {
    kind: slot,
    form: syntacticallyOptional || expanded.optional ? "optional-single" : "single",
    key,
    table: expanded.table,
    contractSource: { source: "type" },
    span: parameter.span,
  };
}

function resolveContractSlot<TType, TSymbol>(
  inputs: ResolveRouteSlotsInputs<TType, TSymbol>,
  parameter: MethodParameter,
  annotation: Extract<TypeNode, { readonly kind: "reference" }>,
  slot: DataSlotKind,
  firstArgument: TypeNode,
): RouteSlotModel | undefined {
  const { context } = inputs;
  const location = `Route handler parameter ${parameter.index} on ${inputs.controllerName}`;
  const projection = projectionKeyOf(annotation.typeArguments[1], slot, context.diagnostics);
  if (projection.failed) {
    return undefined;
  }
  const contractSource = contractSourceOf(context, firstArgument, slot);
  if (contractSource.failed || contractSource.source === undefined) {
    return undefined;
  }
  const contractType = contractTypeFor(inputs, parameter, firstArgument, slot, projection.key);
  if (contractType === undefined) {
    return undefined;
  }
  const expanded = expandContract(context, contractType, parameter.span, false);
  if (expanded.table === undefined) {
    return undefined;
  }
  const table = expanded.table;
  const root = rootShapeOf(table);
  const contractError =
    (slot === "body" ? undefined : stringContractError(root, table, slot)) ??
    projectionKeyError(root, slot, projection.key);
  if (contractError !== undefined) {
    return report(
      context.diagnostics,
      "INVALID_SLOT_CONTRACT",
      `${location}: ${contractError}`,
      parameter.span,
    );
  }
  const wireEntry = wireTableEntryOf(context, contractSource.schemaType, table);
  if (slot === "body") {
    return {
      kind: "body",
      ...(projection.key === undefined ? {} : { key: projection.key }),
      table,
      ...wireEntry,
      contractSource: contractSource.source,
      span: parameter.span,
    };
  }
  return {
    kind: slot,
    form: "contract",
    ...(projection.key === undefined ? {} : { key: projection.key }),
    table,
    ...wireEntry,
    contractSource: contractSource.source,
    span: parameter.span,
  };
}

// 槽位模型的 wireTable 键(#310):非 schema 槽或两侧一致时给空对象,展开处直接 spread。
function wireTableEntryOf<TType, TSymbol>(
  context: SlotResolutionContext<TType, TSymbol>,
  schemaType: TType | undefined,
  table: ContractTable,
): { readonly wireTable?: ContractTable } {
  const wireTable = schemaType === undefined ? undefined : wireTableOf(context, schemaType, table);
  return wireTable === undefined ? {} : { wireTable };
}

// 三字符串槽契约的根与字段裁决(槽位差异):对象根 + 扁平字段。
function stringContractError(
  root: ContractShape,
  table: ContractTable,
  slot: StringSlotKind,
): string | undefined {
  if (root.kind !== "object") {
    return `${slotDisplay[slot]} contracts must have an object root; got a ${root.kind} shape.`;
  }
  for (const field of root.fields) {
    const fieldShape =
      field.shape.kind === "reference"
        ? (table.definitions[field.shape.target]?.shape ?? field.shape)
        : field.shape;
    const error = contractFieldShapeError(field.name, fieldShape, slot);
    if (error !== undefined) {
      return error;
    }
  }
  return undefined;
}

function projectionKeyError(
  root: ContractShape,
  slot: DataSlotKind,
  key: string | undefined,
): string | undefined {
  if (key === undefined) {
    return undefined;
  }
  if (root.kind !== "object" || !root.fields.some((field) => field.name === key)) {
    return `projection key ${JSON.stringify(key)} is not a field of the ${slotDisplay[slot]} contract.`;
  }
  return undefined;
}

// 契约类型的取处:整体形态查参数名位(透明别名下就是契约本身);投影形态参数名位只剩投影后
// 字段类型,整契约必须从契约声明名位取(实测类型实参位查不到,#274)。
function contractTypeFor<TType, TSymbol>(
  inputs: ResolveRouteSlotsInputs<TType, TSymbol>,
  parameter: MethodParameter,
  firstArgument: TypeNode,
  slot: DataSlotKind,
  projectionKey: string | undefined,
): TType | undefined {
  const { context } = inputs;
  const location = `Route handler parameter ${parameter.index} on ${inputs.controllerName}`;
  if (projectionKey === undefined) {
    return requireType(context, context.typeAtParameter(parameter), parameter.span, location);
  }
  if (firstArgument.kind !== "reference") {
    return report(
      context.diagnostics,
      "INVALID_SLOT_CONTRACT",
      `${location}: ${slotDisplay[slot]} projection requires a named contract type as the first type argument.`,
      firstArgument.span,
    );
  }
  const declared = context.contractDeclarationTypeOf(firstArgument);
  if (declared === undefined && context.query !== undefined) {
    return report(
      context.diagnostics,
      "INVALID_SLOT_CONTRACT",
      `${location}: cannot resolve the projected contract ${entityText(firstArgument.name)}; ` +
        "projection needs a non-generic interface or type alias declared in the project.",
      firstArgument.span,
    );
  }
  return requireType(context, declared, firstArgument.span, location);
}

// ———— 响应侧 ————

function isGlobalReference<TType, TSymbol>(
  context: SlotResolutionContext<TType, TSymbol>,
  node: TypeNode,
  globalName: string,
): boolean {
  if (node.kind !== "reference") {
    return false;
  }
  const head = context.headSymbolOf(node.name);
  return head.kind === "global" && head.name === globalName;
}

// 响应侧语法裁决(必须在 expandTypeContract 之前):Response / Promise<Response> 是逃生口
// (#264 决策 7,原样透传);void / Promise<void> 无编码器(运行时 204)。S3(#275)起
// 「无标注」不再归 passthrough——由调用方转推导模式,失败降级 free-form。
function responseIsPassthrough<TType, TSymbol>(
  context: SlotResolutionContext<TType, TSymbol>,
  node: TypeNode,
): boolean {
  if (node.kind === "primitive" && node.name === "void") {
    return true;
  }
  if (isGlobalReference(context, node, "Response")) {
    return true;
  }
  if (
    node.kind === "reference" &&
    isGlobalReference(context, node, "Promise") &&
    node.typeArguments.length === 1
  ) {
    const inner = node.typeArguments[0];
    if (inner !== undefined) {
      if (inner.kind === "primitive" && inner.name === "void") {
        return true;
      }
      if (isGlobalReference(context, inner, "Response")) {
        return true;
      }
    }
  }
  return false;
}

// @ResponseStatus 的字面量提取产物(web-routes 语法层解析)。
export interface ResponseStatusModel {
  readonly value: number;
  readonly span: SourceSpan;
}

// @ResponseSchema 实参(标识符引用),按槽位 schema 同款 schemaTargetOf 追溯。
export interface ResponseSchemaDirectiveModel {
  readonly entity: EntityName;
  readonly span: SourceSpan;
}

export interface ResponseDirectives {
  readonly status?: ResponseStatusModel;
  readonly schema?: ResponseSchemaDirectiveModel;
}

export interface ResolveResponseInputs<TType, TSymbol> {
  readonly context: SlotResolutionContext<TType, TSymbol>;
  // 诊断点名的展示名,如 "Users#show"。
  readonly subject: string;
  readonly annotation: TypeNode | undefined;
  readonly anchorSpan: SourceSpan;
  readonly directives: ResponseDirectives;
  // 状态码规则按角色分岔:路由 table/free-form 缺省 200;错误处理器缺 @ResponseStatus 硬错
  // (ERROR_HANDLER_MISSING_STATUS)、passthrough 上声明硬错(矛盾)。
  readonly role: "route" | "error-handler";
}

// 模式裁决前的中间形:状态码由 applyResponseStatus 统一附加与校验。
type StatuslessResponse =
  | {
      readonly kind: "table";
      readonly table: ContractTable;
      readonly contractSource: ContractSourceModel;
    }
  | { readonly kind: "free-form" }
  | { readonly kind: "passthrough" };

// 响应声明解析的统一入口(S3,#275),路由与错误处理器共用:
// - schema 模式(@ResponseSchema):追溯实参值 → ~standard 复检 → input 侧类型展开,失败硬错;
// - declared 模式(有返回类型标注):语法 passthrough 裁决后走展开管线,诊断照发;
// - inferred 模式(都没写):同一展开管线,任何失败静默降级 free-form。
export function resolveResponseDeclaration<TType, TSymbol>(
  inputs: ResolveResponseInputs<TType, TSymbol>,
): ResponseContractModel | undefined {
  const resolved = resolveStatuslessResponse(inputs);
  if (resolved === undefined) {
    return undefined;
  }
  return applyResponseStatus(inputs, resolved);
}

function resolveStatuslessResponse<TType, TSymbol>(
  inputs: ResolveResponseInputs<TType, TSymbol>,
): StatuslessResponse | undefined {
  const schema = inputs.directives.schema;
  if (schema !== undefined) {
    return resolveSchemaResponse(inputs, schema);
  }
  if (inputs.annotation !== undefined) {
    if (responseIsPassthrough(inputs.context, inputs.annotation)) {
      return { kind: "passthrough" };
    }
    return resolveAnnotatedResponse(inputs);
  }
  return resolveInferredResponse(inputs);
}

function applyResponseStatus<TType, TSymbol>(
  inputs: ResolveResponseInputs<TType, TSymbol>,
  resolved: StatuslessResponse,
): ResponseContractModel | undefined {
  const { context, directives } = inputs;
  if (resolved.kind === "passthrough") {
    if (inputs.role === "error-handler" && directives.status !== undefined) {
      return report(
        context.diagnostics,
        "INVALID_RESPONSE_STATUS",
        `${inputs.subject} returns Response directly and controls its own status; @ResponseStatus contradicts that.`,
        directives.status.span,
        {
          help: "Drop @ResponseStatus, or declare a data-shaped return type and let it drive serialization.",
        },
      );
    }
    return {
      kind: "passthrough",
      ...(directives.status === undefined ? {} : { status: directives.status.value }),
    };
  }
  if (directives.status === undefined && inputs.role === "error-handler") {
    return report(
      context.diagnostics,
      "ERROR_HANDLER_MISSING_STATUS",
      `${inputs.subject} returns a data-shaped response but declares no @ResponseStatus.`,
      inputs.anchorSpan,
      {
        help:
          "A typed error handler that does not return Response must pin its HTTP status with " +
          "@ResponseStatus(...) on the @ErrorHandler class.",
      },
    );
  }
  const status = directives.status?.value ?? 200;
  if (status === 204 || status === 304) {
    return report(
      context.diagnostics,
      "INVALID_RESPONSE_STATUS",
      `${inputs.subject} declares status ${String(status)} on a body-producing response; 204/304 responses must not carry a body.`,
      directives.status?.span ?? inputs.anchorSpan,
      { help: "Return void for an empty response, or pick a status that allows a body." },
    );
  }
  return resolved.kind === "table" ? { ...resolved, status } : { kind: "free-form", status };
}

function resolveSchemaResponse<TType, TSymbol>(
  inputs: ResolveResponseInputs<TType, TSymbol>,
  schema: ResponseSchemaDirectiveModel,
): StatuslessResponse | undefined {
  const { context } = inputs;
  const invalid = (detail: string, help?: string): undefined =>
    report(
      context.diagnostics,
      "INVALID_RESPONSE_SCHEMA",
      `@ResponseSchema on ${inputs.subject} ${detail}`,
      schema.span,
      { help },
    );
  const target = context.schemaTargetOf(schema.entity);
  if (target === undefined) {
    return invalid(
      `cannot statically resolve schema value ${leftmostIdentifier(schema.entity)}.`,
      "Reference a top-level exported const from an application module; re-export chains are not supported.",
    );
  }
  const valueType = requireType(
    context,
    target.type,
    schema.span,
    `The @ResponseSchema value on ${inputs.subject}`,
  );
  if (valueType === undefined) {
    return undefined;
  }
  const standard = standardSchemaVendorOf(context, valueType);
  if (!standard.isStandard) {
    return invalid(
      `references ${leftmostIdentifier(schema.entity)}, which does not implement Standard Schema (missing ~standard.validate).`,
      "Use a Standard Schema v1 library export (zod, valibot, arktype, ...).",
    );
  }
  const inputType = standardSchemaInputTypeOf(context, valueType);
  if (inputType === undefined) {
    return invalid(
      "has no computable wire contract: the schema carries no ~standard.types.input type.",
      "Response schemas must expose their input type through Standard Schema types.",
    );
  }
  const expanded = expandContract(context, inputType, schema.span, false);
  if (expanded.table === undefined) {
    return undefined;
  }
  return {
    kind: "table",
    table: expanded.table,
    contractSource: {
      source: "schema",
      ref: target.ref,
      ...(standard.vendor === undefined ? {} : { vendor: standard.vendor }),
    },
  };
}

function resolveAnnotatedResponse<TType, TSymbol>(
  inputs: ResolveResponseInputs<TType, TSymbol>,
): StatuslessResponse | undefined {
  const { context } = inputs;
  const span = inputs.anchorSpan;
  const query = context.query;
  const methodType = requireType(
    context,
    context.typeAtMethodName(),
    span,
    `The response type of ${inputs.subject}`,
  );
  if (methodType === undefined || query === undefined) {
    return undefined;
  }
  const returnType = query.callSignatureReturnTypes(methodType).find((type) => type !== undefined);
  if (returnType === undefined) {
    return report(
      context.diagnostics,
      "INVALID_SLOT_CONTRACT",
      `The response type of ${inputs.subject} has no computable type; fix TypeScript errors first.`,
      span,
    );
  }
  const unwrapped = query.promiseTypeArgument(returnType) ?? returnType;
  const expanded = expandContract(context, unwrapped, span, false);
  if (expanded.table === undefined) {
    return undefined;
  }
  return { kind: "table", table: expanded.table, contractSource: { source: "type" } };
}

// 推导模式(#275):与 declared 完全同一条展开管线,仅诊断引流与失败语义不同——checker 不可用、
// 类型不可算、展开出任何诊断,全部静默降级 free-form(序列化原样出线,不投影)。前置类型级
// 检查不落 free-form:推导出全局 Response ⇒ 逃生口 passthrough(tsgo 实测 namedDeclarationOf
// 对 ambient Response 答 { name: "Response", declarationPath: <默认库> },非项目类型);
// 推导 void/undefined ⇒ passthrough(运行时 204)。
function resolveInferredResponse<TType, TSymbol>(
  inputs: ResolveResponseInputs<TType, TSymbol>,
): StatuslessResponse {
  const { context } = inputs;
  const query = context.query;
  if (query === undefined) {
    return { kind: "free-form" };
  }
  const methodType = context.typeAtMethodName();
  if (methodType === undefined) {
    return { kind: "free-form" };
  }
  const returnType = query.callSignatureReturnTypes(methodType).find((type) => type !== undefined);
  if (returnType === undefined) {
    return { kind: "free-form" };
  }
  const unwrapped = query.promiseTypeArgument(returnType) ?? returnType;
  const named = query.namedDeclarationOf(unwrapped);
  if (named?.name === "Response" && context.fileIdOf(named.declarationPath) === undefined) {
    return { kind: "passthrough" };
  }
  const intrinsic = query.intrinsicOf(unwrapped);
  if (intrinsic === "void" || intrinsic === "undefined") {
    return { kind: "passthrough" };
  }
  const sink: CompilerDiagnostic[] = [];
  const expanded = expandContract(context, unwrapped, inputs.anchorSpan, false, sink);
  if (expanded.table === undefined || sink.length > 0) {
    return { kind: "free-form" };
  }
  return { kind: "table", table: expanded.table, contractSource: { source: "type" } };
}

// ~standard.types.input 的类型抽取(#275):@ResponseSchema 的线上契约 C。types 在 spec 里
// 声明为 `Types | undefined`,剥掉 undefined 分量后取 input 属性类型。
function standardSchemaInputTypeOf<TType, TSymbol>(
  context: SlotResolutionContext<TType, TSymbol>,
  valueType: TType,
): TType | undefined {
  const query = context.query;
  if (query === undefined) {
    return undefined;
  }
  const standardType = propertyTypeOf(query, valueType, "~standard");
  if (standardType === undefined) {
    return undefined;
  }
  let typesType = propertyTypeOf(query, standardType, "types");
  if (typesType === undefined) {
    return undefined;
  }
  const members = query.unionMembers(typesType);
  if (members !== undefined) {
    const rest = members.filter((member) => query.intrinsicOf(member) !== "undefined");
    const single = rest[0];
    if (rest.length !== 1 || single === undefined) {
      return undefined;
    }
    typesType = single;
  }
  return propertyTypeOf(query, typesType, "input");
}

function propertyTypeOf<TType, TSymbol>(
  query: TypeQueryOf<TType, TSymbol>,
  type: TType,
  name: string,
): TType | undefined {
  const symbol = query.getPropertiesOfType(type).find((item) => query.symbolNameOf(item) === name);
  return symbol === undefined ? undefined : query.getTypesOfSymbols([symbol])[0];
}

function methodNameOf(method: ClassMethodDeclaration): string {
  return method.name.kind === "identifier" ? method.name.name : "<method>";
}

// ———— 硬错 6:Param 键名与路径参数集比对(per-route,web-routes 按路由调用) ————

export function reportUnknownPathParameters(
  contract: RouteContractModel,
  routePath: string,
  pathParameters: ReadonlySet<string>,
  diagnostics: CompilerDiagnostic[],
): boolean {
  let valid = true;
  for (const slot of contract.slots) {
    if (slot.kind !== "param") {
      continue;
    }
    for (const key of paramSlotKeysOf(slot)) {
      if (pathParameters.has(key)) {
        continue;
      }
      valid = false;
      report(
        diagnostics,
        "UNKNOWN_PATH_PARAMETER",
        `Param key ${JSON.stringify(key)} does not appear in route path ${JSON.stringify(routePath)}.`,
        slot.span,
        { help: "Declare the parameter in the route path as :name, or drop the Param binding." },
      );
    }
  }
  return valid;
}

// Param 槽监听的键名集合:单键 = 键名;契约 = 根对象全部字段(解码按整个契约跑,声明路径
// 没有的字段永不可达,同样硬错——#274 复核 P2-7)。
function paramSlotKeysOf(slot: StringRouteSlotModel): readonly string[] {
  if (slot.form !== "contract") {
    return slot.key === undefined ? [] : [slot.key];
  }
  const root = rootShapeOf(slot.table);
  return root.kind === "object" ? root.fields.map((field) => field.name) : [];
}
