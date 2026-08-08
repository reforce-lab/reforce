import { compareUtf16CodeUnits } from "@reforce/primitives";
import type { CompilerDiagnostic } from "@/api";
import { diagnostic } from "@/diagnostics";
import type { SourceSpan } from "@/parser/source-location";
import type { QueryLiteralValue, TypeQueryOf } from "@/typescript/type-query";

// 类型→字段表(RFC 0012 S1,#273):把 checker 算完的类型递归展开成 Web 契约字段表。
// 条件/映射/工具类型全部由 checker 实例化完再取,这里零类型运算;yuku 侧的结构分析不参与,
// 两套 AST 只经 span(offset)对齐。
// 闭集(白名单精神,未列即拒):标量(string/number/bigint/boolean/Date/null)、字面量联合、
// 数组、嵌套对象、判别联合。递归契约一等支持:命名类型提升 definitions 表、回边用引用节点
// 闭合(JSON Schema $defs 精神,将来 OpenAPI components/schemas 近似恒等映射)。
//
// 刻意不复用 LinkedSymbol.key 作 definitions key:它是 linker 在 yuku IR 上的实体身份,经
// Omit/条件类型实例化后的 checker Type 往往不对应任何 linked symbol,搭桥等于重做声明归属。
// key 用「声明文件 fileId + 类型名」,跨模块同名不撞、跨机器确定。

export type ContractScalarKind = "string" | "number" | "bigint" | "boolean" | "date" | "null";

export type ContractLiteralValue =
  | { readonly scalar: "string"; readonly value: string }
  | { readonly scalar: "number"; readonly value: number }
  // bigint 存十进制字符串:字段表必须 plain-JSON 可序列化。
  | { readonly scalar: "bigint"; readonly value: string }
  | { readonly scalar: "boolean"; readonly value: boolean };

// nullable 挂在每个 shape 节点:`T | null` 归一为「T 的 shape + nullable: true」。
// optional 与 nullable 都是使用位属性,definitions 里定义根节点的 nullable 恒为 false。
export type ContractShape =
  | { readonly kind: "scalar"; readonly scalar: ContractScalarKind; readonly nullable: boolean }
  | {
      readonly kind: "literal";
      // 按 (scalar, value) 排序的字面量联合;true|false 同现已在上游合并回 scalar boolean。
      readonly values: readonly ContractLiteralValue[];
      readonly nullable: boolean;
    }
  | {
      readonly kind: "object";
      // 匿名内联对象;fields 按 name UTF-16 排序。
      readonly fields: readonly ContractField[];
      readonly nullable: boolean;
    }
  | { readonly kind: "array"; readonly element: ContractShape; readonly nullable: boolean }
  | {
      readonly kind: "union";
      readonly discriminant: string;
      // 按 tag 值排序。
      readonly members: readonly ContractUnionMember[];
      readonly nullable: boolean;
    }
  | { readonly kind: "reference"; readonly target: string; readonly nullable: boolean };

export interface ContractField {
  readonly name: string;
  readonly optional: boolean;
  readonly shape: ContractShape;
}

export interface ContractUnionMember {
  readonly tag: ContractLiteralValue;
  readonly shape: ContractShape;
}

export interface ContractDefinition {
  // 展示名(OpenAPI 导出候选名)。
  readonly typeName: string;
  readonly shape: ContractShape;
}

export interface ContractTable {
  // 契约入口本身是命名类型时,root 就是一个 reference。
  readonly root: ContractShape;
  // key = `${声明文件 fileId}#${类型名}`,按 UTF-16 排序。
  readonly definitions: Readonly<Record<string, ContractDefinition>>;
}

export interface TypeContractRequest<TType, TSymbol> {
  readonly type: TType;
  readonly span: SourceSpan;
  readonly query: TypeQueryOf<TType, TSymbol>;
  // 声明文件绝对路径 → 项目内 fileId;项目外(node_modules/lib)返回 undefined,对应类型不提升。
  readonly fileIdOf: (declarationPath: string) => string | undefined;
  // 槽位可选单键(RFC 0012 S2,#274):`Query<"page", number | undefined>` 的值类型在根位携带
  // undefined,按属性位口径剥掉并经 rootStrippedUndefined 报告(= 可选);默认保持 S1 的
  // "根位 undefined 硬错"。
  readonly allowUndefinedRoot?: boolean;
}

export interface TypeContractResult {
  // 有 error 则 undefined:error = 图不完整不发射,对齐 RFC 0011 OM2。
  readonly table: ContractTable | undefined;
  readonly diagnostics: readonly CompilerDiagnostic[];
  // 仅 allowUndefinedRoot 时有意义:根位剥掉了 undefined(→ 槽位可选)。
  readonly rootStrippedUndefined: boolean;
}

const allowedShapesHelp =
  "Web contract types are limited to scalars (string, number, bigint, boolean, Date, null), " +
  "literal unions, arrays, plain object shapes, and discriminated object unions.";

function compareLiteralValues(left: ContractLiteralValue, right: ContractLiteralValue): number {
  const byScalar = compareUtf16CodeUnits(left.scalar, right.scalar);
  if (byScalar !== 0) {
    return byScalar;
  }
  if (left.scalar === "number" && right.scalar === "number") {
    return left.value - right.value;
  }
  if (left.scalar === "boolean" && right.scalar === "boolean") {
    return Number(left.value) - Number(right.value);
  }
  return compareUtf16CodeUnits(String(left.value), String(right.value));
}

function sameLiteralValue(left: ContractLiteralValue, right: ContractLiteralValue): boolean {
  return left.scalar === right.scalar && left.value === right.value;
}

function toContractLiteral(literal: QueryLiteralValue): ContractLiteralValue {
  switch (literal.kind) {
    case "string":
      return { scalar: "string", value: literal.value };
    case "number":
      return { scalar: "number", value: literal.value };
    case "bigint":
      return { scalar: "bigint", value: literal.value };
    case "boolean":
      return { scalar: "boolean", value: literal.value };
  }
}

function withNullable(shape: ContractShape, nullable: boolean): ContractShape {
  return nullable ? { ...shape, nullable: true } : shape;
}

interface ExpandedShape {
  readonly shape: ContractShape | undefined;
  // 属性位剥掉了 undefined:并入 optional。
  readonly strippedUndefined: boolean;
}

type DiscriminantEntry =
  | { readonly optional: boolean; readonly literal: ContractLiteralValue | undefined }
  | undefined;

// 候选判别字段的落选原因;undefined = 可用。bigint 字面量不作判别:运行时序列化后无法与
// number 区分。
function discriminantRejection(
  name: string,
  entries: readonly DiscriminantEntry[],
): string | undefined {
  if (entries.some((entry) => entry?.optional === true)) {
    return `\`${name}\` is optional in some members`;
  }
  if (entries.some((entry) => entry?.literal === undefined)) {
    return `\`${name}\` is not a single literal in every member`;
  }
  if (entries.some((entry) => entry?.literal?.scalar === "bigint")) {
    return `\`${name}\` uses bigint literals`;
  }
  const values = entries.flatMap((entry) => (entry?.literal ? [entry.literal] : []));
  const distinct = values.every((value, index) =>
    values.every((other, otherIndex) => index === otherIndex || !sameLiteralValue(value, other)),
  );
  return distinct ? undefined : `\`${name}\` repeats the same literal across members`;
}

export function expandTypeContract<TType, TSymbol>(
  request: TypeContractRequest<TType, TSymbol>,
): TypeContractResult {
  const { query, span, fileIdOf } = request;
  const diagnostics: CompilerDiagnostic[] = [];
  // 每个命名类型只展开一次:回边(含 "expanding" 中的自引用)直接发 reference 节点。
  const definitions = new Map<string, ContractDefinition | "expanding">();
  // 不可提升类型的内联终止判据:typeId 重入 = 整环无一处可提升(全外部声明或泛型实例化的环)。
  const inlineStack = new Set<number>();

  function report(
    code: CompilerDiagnostic["code"],
    path: string,
    message: string,
    help: string,
  ): undefined {
    const location = path === "" ? "The contract type" : `Contract field \`${path}\``;
    diagnostics.push(
      diagnostic({ code, message: `${location} ${message}`, sourceSpan: span, help }),
    );
    return undefined;
  }

  function reportInvalid(path: string, message: string, help = allowedShapesHelp): undefined {
    return report("INVALID_CONTRACT_TYPE", path, message, help);
  }

  function joinPath(path: string, segment: string): string {
    return path === "" ? segment : `${path}${segment.startsWith("[") ? "" : "."}${segment}`;
  }

  // 判别联合成员的预展开视图:候选判别字段搜索与成员展开共用。
  interface MemberView {
    readonly type: TType;
    readonly fields: ReadonlyMap<
      string,
      { readonly optional: boolean; readonly literal: ContractLiteralValue | undefined }
    >;
  }

  function memberViewOf(member: TType): MemberView {
    const properties = [...query.getPropertiesOfType(member)].toSorted((left, right) =>
      compareUtf16CodeUnits(query.symbolNameOf(left), query.symbolNameOf(right)),
    );
    const types = query.getTypesOfSymbols(properties);
    const fields = new Map<
      string,
      { readonly optional: boolean; readonly literal: ContractLiteralValue | undefined }
    >();
    for (const [index, property] of properties.entries()) {
      const propertyType = types[index];
      const literal = propertyType === undefined ? undefined : query.literalOf(propertyType);
      fields.set(query.symbolNameOf(property), {
        optional: query.isOptionalProperty(property),
        literal: literal === undefined ? undefined : toContractLiteral(literal),
      });
    }
    return { type: member, fields };
  }

  function discriminantOf(views: readonly MemberView[], path: string): string | undefined {
    const [first, ...rest] = views;
    if (first === undefined) {
      return undefined;
    }
    // 候选 = 各成员共有的属性名,按 UTF-16 序取首个「必选、单一 string/number/boolean 字面量、
    // 值两两互异」的名字。
    const commonNames = [...first.fields.keys()]
      .filter((name) => rest.every((view) => view.fields.has(name)))
      .toSorted(compareUtf16CodeUnits);
    const rejections: string[] = [];
    for (const name of commonNames) {
      const rejection = discriminantRejection(
        name,
        views.map((view) => view.fields.get(name)),
      );
      if (rejection === undefined) {
        return name;
      }
      rejections.push(rejection);
    }
    const detail =
      rejections.length === 0
        ? "the members share no common required field"
        : rejections.join("; ");
    report(
      "CONTRACT_UNION_NOT_DISCRIMINATED",
      path,
      `is an object union without a usable discriminant: ${detail}.`,
      'Give every union member the same required field holding a distinct literal, e.g. `kind: "a"`.',
    );
    return undefined;
  }

  interface NormalizedUnion {
    nullable: boolean;
    strippedUndefined: boolean;
    readonly rest: TType[];
  }

  // 第一层联合归一:剥 null → nullable;剥 undefined 待属性位并入 optional;
  // 展平嵌套联合(真 checker 已展平,这里兜底 stub/未来形态)。
  function normalizeUnionMembers(members: readonly TType[]): NormalizedUnion {
    const normalized: NormalizedUnion = { nullable: false, strippedUndefined: false, rest: [] };
    const pending = [...members];
    while (pending.length > 0) {
      const member = pending.shift();
      if (member === undefined) {
        continue;
      }
      const nested = query.unionMembers(member);
      if (nested !== undefined && query.intrinsicOf(member) !== "boolean") {
        pending.unshift(...nested);
        continue;
      }
      const intrinsic = query.intrinsicOf(member);
      if (intrinsic === "null") {
        normalized.nullable = true;
        continue;
      }
      if (intrinsic === "undefined") {
        normalized.strippedUndefined = true;
        continue;
      }
      normalized.rest.push(member);
    }
    return normalized;
  }

  function foldLiteralUnion(
    literals: readonly ContractLiteralValue[],
    path: string,
    nullable: boolean,
  ): ContractShape | undefined {
    const hasTrue = literals.some((l) => l.scalar === "boolean" && l.value === true);
    const hasFalse = literals.some((l) => l.scalar === "boolean" && l.value === false);
    if (hasTrue && hasFalse) {
      // true|false 同现即 boolean:只剩这两个成员时合并回标量;再混其他字面量就成了
      // 「boolean 标量 ∪ 字面量」的混合联合,落闭集外。
      if (literals.length === 2) {
        return { kind: "scalar", scalar: "boolean", nullable };
      }
      return reportInvalid(path, "mixes `boolean` with other literals in one union.");
    }
    return { kind: "literal", values: [...literals].toSorted(compareLiteralValues), nullable };
  }

  function isObjectLikeMember(member: TType): boolean {
    return (
      query.literalOf(member) === undefined &&
      query.intrinsicOf(member) === undefined &&
      !query.isTemplateLiteralType(member) &&
      !query.isArrayType(member) &&
      !query.isTupleType(member)
    );
  }

  function expandUnion(
    members: readonly TType[],
    path: string,
    atProperty: boolean,
  ): ExpandedShape {
    const { nullable, strippedUndefined, rest } = normalizeUnionMembers(members);
    const failWith = (shape: ContractShape | undefined): ExpandedShape => ({
      shape,
      strippedUndefined,
    });
    if (strippedUndefined && !atProperty) {
      return failWith(reportInvalid(path, "includes `undefined` outside a property position."));
    }
    if (rest.length === 0) {
      if (!nullable) {
        return failWith(reportInvalid(path, "has no representable member after normalization."));
      }
      return failWith({ kind: "scalar", scalar: "null", nullable: false });
    }
    const single = rest[0];
    if (rest.length === 1 && single !== undefined) {
      const expanded = expandSingle(single, path);
      return failWith(expanded === undefined ? undefined : withNullable(expanded, nullable));
    }

    return failWith(expandMultiMemberUnion(rest, path, nullable));
  }

  // ≥2 成员的联合分派:全字面量 → 折叠;全对象 → 判别搜索;混合/裸标量 → 闭集外。
  function expandMultiMemberUnion(
    rest: readonly TType[],
    path: string,
    nullable: boolean,
  ): ContractShape | undefined {
    const maybeLiterals = rest.map((member) => {
      const literal = query.literalOf(member);
      return literal === undefined ? undefined : toContractLiteral(literal);
    });
    const literals = maybeLiterals.filter((literal) => literal !== undefined);
    if (literals.length === maybeLiterals.length) {
      return foldLiteralUnion(literals, path, nullable);
    }
    if (!rest.every(isObjectLikeMember)) {
      const display = rest.map((member) => query.typeToString(member)).join(" | ");
      return reportInvalid(
        path,
        `is a union of bare scalars or mixed shapes (\`${display}\`); only literal unions and discriminated object unions are supported.`,
      );
    }
    return expandObjectUnion(rest, path, nullable);
  }

  function expandObjectUnion(
    members: readonly TType[],
    path: string,
    nullable: boolean,
  ): ContractShape | undefined {
    const views = members.map(memberViewOf);
    const discriminant = discriminantOf(views, path);
    if (discriminant === undefined) {
      return undefined;
    }
    const expanded: ContractUnionMember[] = [];
    let failed = false;
    for (const view of views) {
      const tag = view.fields.get(discriminant)?.literal;
      const shape = expandSingle(view.type, path);
      if (tag === undefined || shape === undefined) {
        // 成员展开失败继续处理兄弟,一次报全。
        failed = true;
        continue;
      }
      expanded.push({ tag, shape });
    }
    if (failed) {
      return undefined;
    }
    return {
      kind: "union",
      discriminant,
      members: expanded.toSorted((left, right) => compareLiteralValues(left.tag, right.tag)),
      nullable,
    };
  }

  function expandObjectFields(type: TType, path: string): readonly ContractField[] | undefined {
    const properties = [...query.getPropertiesOfType(type)].toSorted((left, right) =>
      compareUtf16CodeUnits(query.symbolNameOf(left), query.symbolNameOf(right)),
    );
    // 同一层属性一次批量取回:IPC 摊薄主手段。
    const types = query.getTypesOfSymbols(properties);
    const fields: ContractField[] = [];
    let failed = false;
    for (const [index, property] of properties.entries()) {
      const name = query.symbolNameOf(property);
      const fieldPath = joinPath(path, name);
      const propertyType = types[index];
      if (propertyType === undefined) {
        reportInvalid(
          fieldPath,
          "has no computable type; fix TypeScript errors on the declaration first.",
        );
        failed = true;
        continue;
      }
      const { shape, strippedUndefined } = expandAt(propertyType, fieldPath, true);
      if (shape === undefined) {
        failed = true;
        continue;
      }
      fields.push({
        name,
        optional: query.isOptionalProperty(property) || strippedUndefined,
        shape,
      });
    }
    return failed ? undefined : fields;
  }

  // 命名且项目内声明的对象/判别联合提升进 definitions;其余内联,typeId 栈保证终止。
  function promoteOrInline(
    type: TType,
    path: string,
    expand: () => ContractShape | undefined,
  ): ContractShape | undefined {
    const named = query.namedDeclarationOf(type);
    const fileId = named === undefined ? undefined : fileIdOf(named.declarationPath);
    if (named !== undefined && fileId !== undefined) {
      const key = `${fileId}#${named.name}`;
      if (definitions.has(key)) {
        return { kind: "reference", target: key, nullable: false };
      }
      definitions.set(key, "expanding");
      const shape = expand();
      if (shape === undefined) {
        // 展开失败留下 "expanding" 占位即可:有 error 时整张表不发射。
        return undefined;
      }
      definitions.set(key, { typeName: named.name, shape });
      return { kind: "reference", target: key, nullable: false };
    }
    const id = query.typeId(type);
    if (inlineStack.has(id)) {
      return reportInvalid(
        path,
        `closes a recursive cycle with no promotable named type (\`${query.typeToString(type)}\`); ` +
          "every type on the cycle is declared outside the project or is a generic instantiation.",
        "Redeclare the recursive type as a non-generic interface or type alias inside the project.",
      );
    }
    inlineStack.add(id);
    const shape = expand();
    inlineStack.delete(id);
    return shape;
  }

  function expandIntrinsic(type: TType, path: string): ContractShape | undefined {
    const intrinsic = query.intrinsicOf(type);
    if (intrinsic === undefined) {
      throw new Error("expandIntrinsic requires an intrinsic type");
    }
    if (
      intrinsic === "string" ||
      intrinsic === "number" ||
      intrinsic === "bigint" ||
      intrinsic === "boolean"
    ) {
      return { kind: "scalar", scalar: intrinsic, nullable: false };
    }
    if (intrinsic === "null") {
      return { kind: "scalar", scalar: "null", nullable: false };
    }
    return reportInvalid(
      path,
      `has type \`${query.typeToString(type)}\`, which is outside the contract closed set.`,
    );
  }

  function expandSingle(type: TType, path: string): ContractShape | undefined {
    const literal = query.literalOf(type);
    if (literal !== undefined) {
      return { kind: "literal", values: [toContractLiteral(literal)], nullable: false };
    }
    if (query.intrinsicOf(type) !== undefined) {
      return expandIntrinsic(type, path);
    }
    if (query.isTemplateLiteralType(type)) {
      return reportInvalid(
        path,
        `is a template literal type (\`${query.typeToString(type)}\`); use \`string\` or a literal union.`,
      );
    }
    const unionMembers = query.unionMembers(type);
    if (unionMembers !== undefined) {
      return expandUnion(unionMembers, path, false).shape;
    }
    if (query.isTupleType(type)) {
      return reportInvalid(
        path,
        `is a tuple type (\`${query.typeToString(type)}\`); use an array of a single element shape.`,
      );
    }
    if (query.isArrayType(type)) {
      return expandArray(type, path);
    }
    return expandObjectLike(type, path);
  }

  function expandArray(type: TType, path: string): ContractShape | undefined {
    const element = query.arrayElementType(type);
    if (element === undefined) {
      return reportInvalid(path, "has an array type whose element type cannot be computed.");
    }
    const elementShape = expandAt(element, joinPath(path, "[]"), false).shape;
    return elementShape === undefined
      ? undefined
      : { kind: "array", element: elementShape, nullable: false };
  }

  function expandObjectLike(type: TType, path: string): ContractShape | undefined {
    // Date 先于 class 判定:Date 放行、`class MyDate extends Date` 落 CONTRACT_CLASS_TYPE。
    // 一条 default-lib 判据覆盖整个内置动物园(Set/Map/TypedArray/…),不维护黑名单。
    if (query.isDeclaredInDefaultLib(type)) {
      if (query.namedDeclarationOf(type)?.name === "Date") {
        return { kind: "scalar", scalar: "date", nullable: false };
      }
      return reportInvalid(
        path,
        `has built-in type \`${query.typeToString(type)}\`; use plain data structures instead.`,
      );
    }
    if (query.isClassType(type)) {
      return report(
        "CONTRACT_CLASS_TYPE",
        path,
        `has class type \`${query.typeToString(type)}\`; classes carry construction and identity semantics that do not survive serialization.`,
        "Describe the payload with an interface or type alias instead of a class.",
      );
    }
    if (query.hasCallSignatures(type)) {
      return reportInvalid(
        path,
        `has a callable type (\`${query.typeToString(type)}\`); functions cannot cross the wire.`,
      );
    }
    const intersectionMembers = query.intersectionMembers(type);
    if (
      intersectionMembers?.some(
        (member) =>
          query.intrinsicOf(member) !== undefined || query.literalOf(member) !== undefined,
      ) === true
    ) {
      // branded 交叉(`string & {…}`):有原始类型成员的交叉不可能是 plain 对象。
      return reportInvalid(
        path,
        `has branded/primitive intersection type \`${query.typeToString(type)}\`; use the underlying scalar.`,
      );
    }
    if (query.hasIndexSignature(type)) {
      return report(
        "CONTRACT_INDEX_SIGNATURE",
        path,
        `has an index signature (\`${query.typeToString(type)}\`); arbitrary keys defeat the contract allowlist.`,
        "Use named fields, or model dynamic pairs as `Array<{ key: …; value: … }>`.",
      );
    }
    // 剩下就是对象形态(交叉的 getProperties/getIndexInfos 已含合并结果,不手工拆)。
    return promoteOrInline(type, path, () => {
      const fields = expandObjectFields(type, path);
      return fields === undefined ? undefined : { kind: "object", fields, nullable: false };
    });
  }

  // 只有「全部成员都是对象形态、且不掺 null/undefined」的联合才具备提升资格:字面量联合
  // (含 enum)按计划保持内联;掺 null 的联合若提升会把使用位属性 nullable 固化进定义根节点。
  function isPromotableObjectUnion(members: readonly TType[]): boolean {
    return members.length >= 2 && members.every(isObjectLikeMember);
  }

  function expandAt(type: TType, path: string, atProperty: boolean): ExpandedShape {
    const unionMembers = query.unionMembers(type);
    if (unionMembers !== undefined && query.intrinsicOf(type) !== "boolean") {
      // 命名判别联合(alias 指向对象联合)在联合归一之前抓住提升机会:直接引用处 `s: Shape`
      // 的 checker 类型仍带 alias;`Shape | null` 这类合成联合已被 checker 展平,只能内联。
      const named = query.namedDeclarationOf(type);
      if (
        named !== undefined &&
        fileIdOf(named.declarationPath) !== undefined &&
        isPromotableObjectUnion(unionMembers)
      ) {
        const shape = promoteOrInline(
          type,
          path,
          () => expandUnion(unionMembers, path, false).shape,
        );
        return { shape, strippedUndefined: false };
      }
      return expandUnion(unionMembers, path, atProperty);
    }
    return { shape: expandSingle(type, path), strippedUndefined: false };
  }

  const root = expandAt(request.type, "", request.allowUndefinedRoot === true);
  if (diagnostics.length > 0 || root.shape === undefined) {
    if (diagnostics.length === 0) {
      reportInvalid("", "cannot be expanded into a contract shape.");
    }
    return { table: undefined, diagnostics, rootStrippedUndefined: root.strippedUndefined };
  }
  const orderedDefinitions: Record<string, ContractDefinition> = {};
  for (const key of [...definitions.keys()].toSorted(compareUtf16CodeUnits)) {
    const definition = definitions.get(key);
    if (definition === undefined || definition === "expanding") {
      // 无 error 时每个提升都已落定义;走到这里是算法 bug,宁可硬错也不发射半张表。
      throw new Error(`Contract definition ${key} never completed.`);
    }
    orderedDefinitions[key] = definition;
  }
  return {
    table: { root: root.shape, definitions: Object.freeze(orderedDefinitions) },
    diagnostics,
    rootStrippedUndefined: root.strippedUndefined,
  };
}
