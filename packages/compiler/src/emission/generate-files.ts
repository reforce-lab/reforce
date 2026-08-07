import { compareUtf16CodeUnits } from "@reforce/primitives";
import type { WeavingModel, WovenBeanModel, WovenMethodModel } from "@/analysis/interception-model";
import {
  contextFrameworkLoggerBeanId,
  contextFrameworkLoggerName,
  loggerBeanIdPrefix,
  webFrameworkLoggerBeanId,
} from "@/analysis/logger-synthesis";
import {
  type BeanProviderModel,
  type ConfigProviderModel,
  type DependencyModel,
  type ExecutionPlansModel,
  isCollectionDependency,
  type ProviderModel,
  sourceReference,
} from "@/analysis/model";
import type { WebModel } from "@/analysis/web-model";
import type { GeneratedFile, ResolvedApplicationProject } from "@/api";
import { generateWeavingFile } from "@/emission/generate-weaving-file";
import { generateWebFiles, webRuntimeModuleSpecifier } from "@/emission/generate-web-files";
import { compactJson, inlineJson, json, runtimeSpecifier } from "@/emission/render";
import type { LinkedSymbol } from "@/linking/model";
import { generatedDirectoryPath } from "@/project/generated-paths";

const contextModuleSpecifier = "@reforce/context";
const contextRuntimeModuleSpecifier = "@reforce/context/generated-runtime";
const configRuntimeModuleSpecifier = "@reforce/config/generated-runtime";
const loggingRuntimeModuleSpecifier = "@reforce/logging/generated-runtime";

// 外部契约符号（starter/契约包）的 type-only import specifier 由链接层决定：meta 户口表的
// subpath 优先，无表退化为包根探测。应用源集内的符号 emission 自己算相对路径。
export interface EmissionTypeResolver {
  contractImportSpecifier(symbol: LinkedSymbol): string | undefined;
}

function sourceReferenceForSymbol(symbol: LinkedSymbol) {
  const span = symbol.declaration?.span;
  return span === undefined ? undefined : sourceReference(span);
}

function symbolReference(
  symbol: LinkedSymbol,
  generatedDirectory: string,
): Record<string, unknown> {
  if (symbol.source === undefined) {
    // 外部符号：moduleSpecifier 已是包视角 specifier；declaration span 属于包内文件，
    // 不落进 manifest（manifest 的 span 一律指应用可寻址的相对路径）。
    return {
      displayName: symbol.name,
      moduleSpecifier: symbol.moduleSpecifier,
      exportName: symbol.name,
      declaration: undefined,
    };
  }
  return {
    displayName: symbol.name,
    moduleSpecifier: runtimeSpecifier(generatedDirectory, symbol.source.absolutePath),
    exportName: symbol.name,
    declaration: sourceReferenceForSymbol(symbol),
  };
}

// DependencyModel 的 contract 字段只服务 typed-edge 生成；manifest 与 beans.ts 内嵌 JSON 都必须
// 保持运行时 GeneratedDependency 的封闭形状（ADR 0004 决策 14：运行时 schema 一个字段不加）。
// 集合边是 schema v3 的第二形态（ADR 0006 W6，#150）：members 顺序即注入顺序。
function runtimeDependencies(provider: ProviderModel): readonly Record<string, unknown>[] {
  return provider.dependencies.map((dependency) =>
    isCollectionDependency(dependency)
      ? {
          parameterIndex: dependency.parameterIndex,
          mode: "collection",
          members: dependency.members.map((member) => ({
            targetId: member.targetId,
            mode: member.mode,
          })),
          source: dependency.source,
        }
      : {
          parameterIndex: dependency.parameterIndex,
          targetId: dependency.targetId,
          mode: dependency.mode,
          source: dependency.source,
        },
  );
}

// bean 身份里的 exportName 与真实运行导出名只在框架 logger 上分家：一个 BoundLogger 承载 N 个
// bean 身份，身份段是 `Logger(OrderService)`，而 import 与 manifest 要的是真的能 import 到的名字。
// 其余框架 bean（TransactionInterceptor）两者逐字相同，这里对它们是恒等。
function providerRuntimeExportName(provider: ProviderModel): string {
  return provider.origin.kind === "application"
    ? provider.exportName
    : provider.origin.runtimeExport.export;
}

function providerValueSpecifier(provider: ProviderModel, generatedDirectory: string): string {
  return provider.origin.kind === "application"
    ? runtimeSpecifier(generatedDirectory, provider.origin.source.absolutePath)
    : provider.origin.runtimeExport.module;
}

interface ContractImport {
  readonly symbol: LinkedSymbol;
  readonly specifier: string;
  readonly alias: string;
}

// 框架契约（TransactionManager / TransactionInterceptor，#204 定案 6）：type-only import
// 直接用符号携带的框架 specifier，不走 starter meta 户口表。
function contractSpecifierOf(
  symbol: LinkedSymbol,
  generatedDirectory: string,
  typeResolver: EmissionTypeResolver,
): string | undefined {
  if (symbol.kind === "context" || symbol.kind === "transaction") {
    return symbol.moduleSpecifier;
  }
  return symbol.source === undefined
    ? typeResolver.contractImportSpecifier(symbol)
    : runtimeSpecifier(generatedDirectory, symbol.source.absolutePath);
}

function contractImports(
  providers: readonly ProviderModel[],
  generatedDirectory: string,
  typeResolver: EmissionTypeResolver,
): ReadonlyMap<string, ContractImport> {
  const bySymbolKey = new Map<string, { symbol: LinkedSymbol; specifier: string }>();
  for (const provider of providers) {
    for (const dependency of provider.dependencies) {
      const symbol = dependency.contract;
      if (bySymbolKey.has(symbol.key)) {
        continue;
      }
      const specifier = contractSpecifierOf(symbol, generatedDirectory, typeResolver);
      if (specifier !== undefined) {
        bySymbolKey.set(symbol.key, { symbol, specifier });
      }
    }
  }
  const ordered = [...bySymbolKey.values()].toSorted((left, right) => {
    const specifier = compareUtf16CodeUnits(left.specifier, right.specifier);
    if (specifier !== 0) {
      return specifier;
    }
    const name = compareUtf16CodeUnits(left.symbol.name, right.symbol.name);
    return name === 0 ? compareUtf16CodeUnits(left.symbol.key, right.symbol.key) : name;
  });
  return new Map(
    ordered.map((entry, index) => [
      entry.symbol.key,
      { symbol: entry.symbol, specifier: entry.specifier, alias: `beanContract${index}` },
    ]),
  );
}

function dependencyExpression(
  dependency: DependencyModel,
  contracts: ReadonlyMap<string, ContractImport>,
): string {
  const alias = contracts.get(dependency.contract.key)?.alias;
  const typeArgument = alias === undefined ? "" : `<${alias}>`;
  // typed-edge 纪律不因集合降级（#150）：resolveAll<T>() 的 T 是元素契约，tsc 背书数组元素类型。
  if (isCollectionDependency(dependency)) {
    return `resolver.resolveAll${typeArgument}(${dependency.parameterIndex})`;
  }
  // current 边同理（#151）：resolver.current<T>() 产出 Current<T> 句柄，tsc 背书句柄的元素类型。
  if (dependency.mode === "current") {
    return `resolver.current${typeArgument}(${dependency.parameterIndex})`;
  }
  return dependency.mode === "explicit-lazy"
    ? `resolver.lazy${typeArgument}(${dependency.parameterIndex})`
    : `resolver.resolve${typeArgument}(${dependency.parameterIndex})`;
}

// $Woven emission（ADR 0008 AM1，#202）：仅"存在非空链方法"的 bean 织出子类；打了标记但
// 全部空链的 bean 不产 wrapper（标记是元数据，行为来自拦截器，织入表里可审）。
interface WovenEmission {
  readonly model: WovenBeanModel;
  // 非空链方法（模型内已按方法名排序）。
  readonly methods: readonly WovenMethodModel[];
  // 用户构造参数个数：追加的拦截器边从它之后顺延，$Woven 构造尾参接链表。
  readonly userParameterCount: number;
}

function wovenEmissions(
  providers: readonly BeanProviderModel[],
  weaving: WeavingModel,
): ReadonlyMap<string, WovenEmission> {
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const emissions = new Map<string, WovenEmission>();
  for (const model of weaving.beans) {
    const methods = model.methods.filter((method) => method.chain.length > 0);
    const provider = providerById.get(model.beanId);
    if (methods.length === 0 || provider === undefined) {
      continue;
    }
    const interceptorIndexes = new Set(
      methods.flatMap((method) => method.chain.map((entry) => entry.parameterIndex)),
    );
    emissions.set(model.beanId, {
      model,
      methods,
      userParameterCount: provider.dependencies.length - interceptorIndexes.size,
    });
  }
  return emissions;
}

// 链类型按被织方法的返回类型参数化（#202 风险 1 的第二轮收紧）：替换型拦截器挂错方法时，
// beans.ts 过 tsc 就红——链与它所服务的方法在类型层绑定，不再靠 Promise<unknown> 掩盖。
// 每个方法一条 Record 项而非共用一个键并集，因为不同方法的返回类型不同。
function wovenChainsType(alias: string, woven: WovenEmission): string {
  const members = woven.methods.map((method) => {
    const signature = `InstanceType<typeof ${alias}>[${JSON.stringify(method.method)}]`;
    return `${JSON.stringify(method.method)}: GeneratedMethodChain<Awaited<ReturnType<${signature}>>>`;
  });
  return `Readonly<{ ${members.join("; ")} }>`;
}

// override 的实参/返回类型全部经 Parameters/ReturnType/InstanceType 从用户类索引回来
// （typed-edge 纪律）：beans.ts 过 tsc 即证明被织方法存在、签名兼容，生成代码零断言。
// invokeIntercepted 内部同样零断言——返回类型由两个拦截器接口在类型层各自堵死。
function wovenOverride(alias: string, field: string, method: WovenMethodModel): string {
  const signature = `InstanceType<typeof ${alias}>[${JSON.stringify(method.method)}]`;
  return [
    `  override ${method.method}(...args: Parameters<${signature}>): ReturnType<${signature}> {`,
    `    return invokeIntercepted<ReturnType<${signature}>>(this.${field}.${method.method}, args, () =>`,
    `      super.${method.method}(...args),`,
    "    );",
    "  }",
  ].join("\n");
}

function wovenClassDeclaration(index: number, woven: WovenEmission): string {
  const alias = `beanTarget${index}`;
  const constructorParameters = [
    ...Array.from(
      { length: woven.userParameterCount },
      (_, parameter) =>
        `    argument${parameter}: ConstructorParameters<typeof ${alias}>[${parameter}],`,
    ),
    `    private readonly ${woven.model.chainFieldName}: ${wovenChainsType(alias, woven)},`,
  ];
  const superArguments = Array.from(
    { length: woven.userParameterCount },
    (_, parameter) => `argument${parameter}`,
  ).join(", ");
  return [
    `class ${alias}$Woven extends ${alias} {`,
    "  constructor(",
    ...constructorParameters,
    "  ) {",
    `    super(${superArguments});`,
    "  }",
    "",
    ...woven.methods.map((method) => wovenOverride(alias, woven.model.chainFieldName, method)),
    "}",
  ].join("\n");
}

// create 改写：用户参 resolver 表达式不动，尾参内联链表字面量——entries 按编译期压平序，
// interceptor 经追加依赖边的 resolver 槽位解析（typed-edge 同样生效），标记值单行稳定
// 序列化、0 参标记落 undefined（运行时 ctx.value 词汇）。
function wovenChainsLiteral(
  provider: BeanProviderModel,
  woven: WovenEmission,
  contracts: ReadonlyMap<string, ContractImport>,
): string {
  const dependencyByIndex = new Map(
    provider.dependencies.map((dependency) => [dependency.parameterIndex, dependency]),
  );
  const methods = woven.methods.map((method) => {
    const entries = method.chain.map((entry) => {
      const dependency = dependencyByIndex.get(entry.parameterIndex);
      if (dependency === undefined) {
        throw new Error(`Missing interceptor dependency ${entry.beanId} on ${provider.id}`);
      }
      const value = entry.value === null ? "undefined" : compactJson(entry.value);
      return `        { interceptor: ${dependencyExpression(dependency, contracts)}, value: ${value} },`;
    });
    return [
      `      ${method.method}: {`,
      `        beanId: ${JSON.stringify(woven.model.beanId)},`,
      `        method: ${JSON.stringify(method.method)},`,
      "        entries: [",
      ...entries.map((entry) => `  ${entry}`),
      "        ],",
      "      },",
    ].join("\n");
  });
  return `{\n${methods.join("\n")}\n    }`;
}

function literalArgumentAlias(index: number): string {
  return `beanTarget${index}$Literal`;
}

// 框架 logger 的 target 类要能被 bootstrap 按类取到（RFC 0011 L6，#250）：它的需求方是生成的
// bootstrap，不在 DI 图内，而 logger 的运行导出 BoundLogger 承载 N 个 bean 身份、按类取会撞。
// 导出的是那个逐 logger 子类，`context.get` 因此落在唯一一条 registration 上。
function frameworkLoggerAlias(
  providers: readonly BeanProviderModel[],
  beanId: string,
): string | undefined {
  return providers
    .flatMap((provider, index) =>
      provider.id === beanId ? [literalArgumentTarget(provider, index)] : [],
    )
    .find((alias) => alias !== undefined);
}

// 引导期缓冲的重放要的是 LoggerFactory 实例，而不是 logger（RFC 0011 L7，#250）：
// replayBootstrapLogs 按记录里的原始 logger 名逐条 factory.create(name)，一个 logger 实例
// 换不来别的名字。
//
// 哪个 bean 是 LoggerFactory 由图自己回答，不再重新推导一遍：每条合成的 logger bean 恰好有
// 一条依赖边，指的就是它。
function loggerFactoryBeanId(providers: readonly BeanProviderModel[]): string | undefined {
  const logger = providers.find((provider) => provider.id.startsWith(`${loggerBeanIdPrefix}(`));
  const dependency = logger?.dependencies.find((edge) => !isCollectionDependency(edge));
  return dependency === undefined || isCollectionDependency(dependency)
    ? undefined
    : dependency.targetId;
}

function loggerFactoryAlias(providers: readonly BeanProviderModel[]): string | undefined {
  const id = loggerFactoryBeanId(providers);
  if (id === undefined) {
    return undefined;
  }
  const index = providers.findIndex((provider) => provider.id === id);
  // 别名恒为 beanTarget<N> 而不是 $Literal 子类：registration.target 用的就是它，
  // `context.get` 因此落在这条 registration 上。LoggerFactory 没有字面量实参，两者本就相同。
  return index < 0 ? undefined : `beanTarget${index}`;
}

interface LoggingExports {
  /** 容器面那条（RFC 0011 L6【已定】）：摘要、台账、关停与崩溃归它，有绑定就恒在。 */
  readonly contextLogger?: string;
  /** web 面那条：请求日志、未命中与监听行归它，装了引擎才有。 */
  readonly frameworkLogger?: string;
  readonly loggerFactory?: string;
}

function loggingExports(providers: readonly BeanProviderModel[]): LoggingExports {
  const contextLogger = frameworkLoggerAlias(providers, contextFrameworkLoggerBeanId);
  const logger = frameworkLoggerAlias(providers, webFrameworkLoggerBeanId);
  const factory = loggerFactoryAlias(providers);
  return {
    ...(contextLogger === undefined ? {} : { contextLogger }),
    ...(logger === undefined ? {} : { frameworkLogger: logger }),
    ...(factory === undefined ? {} : { loggerFactory: factory }),
  };
}

function frameworkLoggerExport(providers: readonly BeanProviderModel[]): readonly string[] {
  const exports = loggingExports(providers);
  const names = [
    ...(exports.contextLogger === undefined ? [] : [`${exports.contextLogger} as contextLogger`]),
    ...(exports.frameworkLogger === undefined
      ? []
      : [`${exports.frameworkLogger} as frameworkLogger`]),
    ...(exports.loggerFactory === undefined ? [] : [`${exports.loggerFactory} as loggerFactory`]),
  ];
  return names.length === 0 ? [] : [`export { ${names.join(", ")} };`];
}

// 只有带字面量实参的 provider 需要子类：其余的 target 仍然是用户类本身，bean 身份表与
// testing replace 的键都不换（ADR 0008 AM1）。
function literalArgumentTarget(provider: BeanProviderModel, index: number): string | undefined {
  if (provider.kind !== "class" || provider.literalArguments === undefined) {
    return undefined;
  }
  return literalArgumentAlias(index);
}

function literalArgumentClassDeclaration(
  provider: BeanProviderModel,
  index: number,
): readonly string[] {
  const target = literalArgumentTarget(provider, index);
  return target === undefined ? [] : [`class ${target} extends beanTarget${index} {}`];
}

// 依赖表达式与字面量按 parameterIndex 归并成一份实参表。先例是 wovenChainsLiteral 的尾参
// 内联，区别只在这里的字面量可以落在任意参数位，不限于末位。
function constructorArguments(
  provider: BeanProviderModel,
  dependencies: readonly DependencyModel[],
  contracts: ReadonlyMap<string, ContractImport>,
): string {
  const literals = provider.kind === "class" ? (provider.literalArguments ?? []) : [];
  if (literals.length === 0) {
    return dependencies.map((dependency) => dependencyExpression(dependency, contracts)).join(", ");
  }
  const byIndex = new Map<number, string>();
  for (const dependency of dependencies) {
    byIndex.set(dependency.parameterIndex, dependencyExpression(dependency, contracts));
  }
  for (const literal of literals) {
    byIndex.set(literal.index, compactJson(literal.value));
  }
  const width = Math.max(...byIndex.keys()) + 1;
  return Array.from(
    { length: width },
    (_value, position) => byIndex.get(position) ?? "undefined",
  ).join(", ");
}

function registrationExpression(
  provider: BeanProviderModel,
  index: number,
  contracts: ReadonlyMap<string, ContractImport>,
  woven: WovenEmission | undefined,
): string {
  const alias = `beanTarget${index}`;
  // factoryBean 的 scope 由 defineBean 选项自证（同一字面量既是编译输入也是运行时输入），
  // 不重复写入；classBean 无处自证，scope 必须显式落进生成物（ADR 0006 W7）。
  if (provider.kind === "factory") {
    return `const registration${index} = factoryBean({\n  id: ${JSON.stringify(provider.id)},\n  source: ${inlineJson(provider.declarationSource, 2)},\n  definition: ${alias},\n});`;
  }
  const orderedDependencies = provider.dependencies.toSorted(
    (left, right) => left.parameterIndex - right.parameterIndex,
  );
  // registration.target 保持用户类：bean 身份表与 testing replace 的键不换（ADR 0008 AM1）。
  const userDependencies =
    woven === undefined
      ? orderedDependencies
      : orderedDependencies.slice(0, woven.userParameterCount);
  const argumentsList = constructorArguments(provider, userDependencies, contracts);
  // 逐 logger emit 一个子类（RFC 0011 L2，#242）：运行时的 claimClassTarget 要求每条 class
  // registration 的 target 对象互不相同，N 个 logger bean 共用一个 BoundLogger 会当场
  // fail("class target ... is duplicated")。子类对用户不可达，所以 context.get(BoundLogger)
  // 抛 UnregisteredBeanTargetError——语义正确，logger 本来就不该按类取。
  const target = literalArgumentTarget(provider, index) ?? alias;
  const createExpression =
    woven === undefined
      ? `new ${target}(${argumentsList})`
      : `new ${alias}$Woven(${argumentsList.length === 0 ? "" : `${argumentsList}, `}${wovenChainsLiteral(provider, woven, contracts)})`;
  const hooks = [
    ...(provider.startHook ? ["start: (bean) => bean.onContextStart(),"] : []),
    ...(provider.closeHook ? ["close: (bean) => bean.onContextClose(),"] : []),
  ];
  const hooksBlock =
    hooks.length === 0 ? "{}" : `{\n${hooks.map((line) => `    ${line}`).join("\n")}\n  }`;
  return `const registration${index} = classBean({\n  id: ${JSON.stringify(provider.id)},\n  source: ${inlineJson(provider.declarationSource, 2)},\n  scope: ${JSON.stringify(provider.scope)},\n  target: ${target},\n  dependencies: ${inlineJson(runtimeDependencies(provider), 2)},\n  create: (resolver) => ${createExpression},\n  hooks: ${hooksBlock},\n});`;
}

function renderBeans(
  providers: readonly BeanProviderModel[],
  configs: readonly ConfigProviderModel[],
  plans: ExecutionPlansModel,
  weaving: WeavingModel,
  generatedDirectory: string,
  typeResolver: EmissionTypeResolver,
): string {
  const contracts = contractImports(providers, generatedDirectory, typeResolver);
  const woven = wovenEmissions(providers, weaving);
  const runtimeValueImports = [
    "classBean",
    ...(configs.length > 0 ? ["configBean"] : []),
    "factoryBean",
    ...(woven.size > 0 ? ["invokeIntercepted"] : []),
  ];
  const runtimeTypeImports = [
    "GeneratedApplicationDefinition",
    ...(woven.size > 0 ? ["GeneratedMethodChain"] : []),
  ];
  const runtimeImports = [
    `import { ${runtimeValueImports.join(", ")} } from "${contextRuntimeModuleSpecifier}";`,
    `import type { ${runtimeTypeImports.join(", ")} } from "${contextRuntimeModuleSpecifier}";`,
    // 无 config 的应用不引入 @reforce/config：该依赖只在声明了 config class 时才需要安装。
    ...(configs.length > 0
      ? [`import { createConfigBinding } from "${configRuntimeModuleSpecifier}";`]
      : []),
  ];
  const imports = providers.map((provider, index) => {
    const specifier = providerValueSpecifier(provider, generatedDirectory);
    return `import { ${providerRuntimeExportName(provider)} as beanTarget${index} } from ${JSON.stringify(specifier)};`;
  });
  const configImports = configs.map((config, index) => {
    const specifier = providerValueSpecifier(config, generatedDirectory);
    return `import { ${config.exportName} as configTarget${index} } from ${JSON.stringify(specifier)};`;
  });
  // typed-edge 的类型标注（ADR 0004 决策 8）：type-only import 编译后消失，运行时零痕迹；
  // tsc 对每条 resolve<T>() 的实参赋值做结构校验，是链接错误的最后一道背书。
  const typeImports = [...contracts.values()].map(
    (contract) =>
      `import type { ${contract.symbol.name} as ${contract.alias} } from ${JSON.stringify(contract.specifier)};`,
  );
  const configRegistrations = configs.map(
    (config, index) =>
      `const config${index} = configBean({\n  id: ${JSON.stringify(config.id)},\n  source: ${inlineJson(config.declarationSource, 2)},\n  target: configTarget${index},\n});`,
  );
  const wovenClasses = providers.flatMap((provider, index) => {
    const emission = woven.get(provider.id);
    return [
      ...literalArgumentClassDeclaration(provider, index),
      ...(emission === undefined ? [] : [wovenClassDeclaration(index, emission)]),
    ];
  });
  const registrations = providers.map((provider, index) =>
    registrationExpression(provider, index, contracts, woven.get(provider.id)),
  );
  const names = providers.map((_, index) => `registration${index}`).join(", ");
  const configNames = configs.map((_, index) => `config${index}`).join(", ");
  return `${[
    ...runtimeImports,
    ...imports,
    ...configImports,
    ...typeImports,
    "",
    ...wovenClasses.flatMap((declaration) => [declaration, ""]),
    ...configRegistrations.flatMap((registration) => [registration, ""]),
    ...registrations.flatMap((registration) => [registration, ""]),
    ...frameworkLoggerExport(providers).flatMap((line) => [line, ""]),
    "export const applicationDefinition = {",
    "  schemaVersion: 5,",
    `  configs: [${configNames}],`,
    ...(configs.length > 0 ? ["  configBinding: createConfigBinding(),"] : []),
    `  registrations: [${names}],`,
    `  plans: ${inlineJson(plans, 2)},`,
    "} as const satisfies GeneratedApplicationDefinition;",
  ].join("\n")}\n`;
}

interface QualifierGroup {
  readonly symbol: LinkedSymbol;
  readonly members: readonly { readonly member: string; readonly beanId: string }[];
}

interface RenderedQualifierGroup extends QualifierGroup {
  readonly alias: string;
  readonly specifier: string;
}

interface QualifierModuleGroup {
  readonly specifier: string;
  readonly interfaces: readonly RenderedQualifierGroup[];
}

function qualifierGroups(
  providers: readonly ProviderModel[],
  generatedDirectory: string,
): readonly RenderedQualifierGroup[] {
  const groups = new Map<
    string,
    { symbol: LinkedSymbol; members: { member: string; beanId: string }[] }
  >();
  for (const provider of providers) {
    for (const qualifier of provider.qualifiers) {
      const group = groups.get(qualifier.interfaceSymbol.key) ?? {
        symbol: qualifier.interfaceSymbol,
        members: [],
      };
      group.members.push({ member: qualifier.member, beanId: provider.id });
      groups.set(qualifier.interfaceSymbol.key, group);
    }
  }
  return [...groups.values()]
    .map((group) => {
      const source = group.symbol.source;
      if (source === undefined) {
        throw new Error("Qualifier interface must belong to the application source set");
      }
      return {
        symbol: group.symbol,
        members: group.members.toSorted((left, right) => {
          const member = compareUtf16CodeUnits(left.member, right.member);
          return member === 0 ? compareUtf16CodeUnits(left.beanId, right.beanId) : member;
        }),
        specifier: runtimeSpecifier(generatedDirectory, source.absolutePath),
      };
    })
    .toSorted((left, right) => {
      const specifier = compareUtf16CodeUnits(left.specifier, right.specifier);
      if (specifier !== 0) {
        return specifier;
      }
      const name = compareUtf16CodeUnits(left.symbol.name, right.symbol.name);
      return name === 0 ? compareUtf16CodeUnits(left.symbol.key, right.symbol.key) : name;
    })
    .map((group, index) => ({ ...group, alias: `InterfaceType${index}` }));
}

function qualifierModuleGroups(
  interfaces: readonly RenderedQualifierGroup[],
): readonly QualifierModuleGroup[] {
  const modules = new Map<string, RenderedQualifierGroup[]>();
  for (const group of interfaces) {
    const existing = modules.get(group.specifier) ?? [];
    existing.push(group);
    modules.set(group.specifier, existing);
  }
  return [...modules].map(([specifier, groups]) => ({ specifier, interfaces: groups }));
}

function renderQualifiers(providers: readonly ProviderModel[], generatedDirectory: string): string {
  const interfaces = qualifierGroups(providers, generatedDirectory);
  if (interfaces.length === 0) {
    return "export {};\n";
  }
  const imports = interfaces.map(
    (group) =>
      `import type { ${group.symbol.name} as ${group.alias} } from ${JSON.stringify(group.specifier)};`,
  );
  const declarations = qualifierModuleGroups(interfaces).map((module) => {
    const namespaces = module.interfaces.map((group) => {
      const members = group.members.map(
        (member) =>
          `    type ${member.member} = QualifiedBean<${group.alias}, ${JSON.stringify(member.beanId)}>;`,
      );
      return `  namespace ${group.symbol.name} {\n${members.join("\n")}\n  }`;
    });
    return `declare module ${JSON.stringify(module.specifier)} {\n${namespaces.join("\n\n")}\n}`;
  });
  return `${[
    `import type { QualifiedBean } from "${contextModuleSpecifier}";`,
    ...imports,
    "",
    ...declarations.flatMap((declaration) => [declaration, ""]),
  ]
    .join("\n")
    .trimEnd()}\n`;
}

function renderManifest(
  providers: readonly BeanProviderModel[],
  configs: readonly ConfigProviderModel[],
  plans: ExecutionPlansModel,
  generatedDirectory: string,
): string {
  const manifestConfigs = configs.map((config) => ({
    id: config.id,
    prefix: config.prefix,
    source: config.declarationSource,
    provides: config.provides.map((symbol) => symbolReference(symbol, generatedDirectory)),
  }));
  const beans = providers.map((provider) => ({
    id: provider.id,
    kind: provider.kind,
    // scope 是编译期属性（ADR 0006 W7）：静态可查可 diff，运行时不做任何推断。
    scope: provider.scope,
    origin: provider.origin.kind === "application" ? "application" : provider.origin.origin,
    source: provider.declarationSource,
    runtimeExport: {
      moduleSpecifier: providerValueSpecifier(provider, generatedDirectory),
      exportName: providerRuntimeExportName(provider),
    },
    provides: provider.provides.map((symbol) => symbolReference(symbol, generatedDirectory)),
    dependencies: runtimeDependencies(provider),
    primary: provider.primary,
    // @Order 值进 manifest（ADR 0006 W6：成员顺序静态可查可 diff）；未标记的 bean 不写该键。
    ...(provider.order === undefined ? {} : { order: provider.order }),
    qualifiers: provider.qualifiers.map((qualifier) => ({
      interface: symbolReference(qualifier.interfaceSymbol, generatedDirectory),
      member: qualifier.member,
    })),
    lifecycle: {
      start: provider.kind === "class" && provider.startHook,
      close: provider.kind === "class" && provider.closeHook,
      dispose: provider.kind === "factory" && provider.dispose,
    },
  }));
  return `${json({ schemaVersion: 5, configs: manifestConfigs, beans, plans })}\n`;
}

// web 接线（ADR 0006 W2 的 #153 修订）：路由表与容器只有生成代码同时拿得到，注册了 web 引擎
// starter 时 bootstrap 负责把两者交给 connectWebApplication（组装 + 启动引擎 + 关闭编排）。
// 无引擎的应用保持零 import 的哑 bootstrap，逐字节不变。
// 容器 start 那一段对两种 bootstrap 是同一份（RFC 0011 L7，#250）：起点计时 → start →
// 失败即把引导期缓冲吐到 stderr（不变量 9：日志系统自身故障必须最吵，绝不静默降级）→
// 成功即重放缓冲进真绑定。没装日志绑定的应用退化成裸 start，逐字节与此前相同。
function contextStartLines(logging: LoggingExports, beanCount: number): readonly string[] {
  if (logging.loggerFactory === undefined) {
    return [
      "  const application = createApplicationContext(applicationDefinition);",
      "  await application.start();",
    ];
  }
  return [
    "  const startedAt = Date.now();",
    "  const application = createApplicationContext(applicationDefinition);",
    // 写 `.catch` 而不是 try/catch：hoist 出来的 startReport 在 catch 之后会被窄化成
    // `ContextStartReport | undefined`，读 .beanTimings 过不了 strictNullChecks。回调返回
    // never，await 出来的类型仍是 ContextStartReport。
    "  const startReport = await application.start().catch((error) => {",
    // 绑定构造失败时缓冲是唯一的现场。显式排空而不是只靠 exit 兜底：调用方接着要打自己的
    // 错误，那些输出会排在缓冲之前，把因果顺序颠倒过来。
    "    drainBootstrapLogs();",
    "    throw error;",
    "  });",
    `  const contextMs = Date.now() - startedAt;`,
    // 重放要 LoggerFactory 而不是 logger：缓冲里的记录各带自己的 logger 名。
    "  replayBootstrapLogs(application.get(loggerFactory));",
    `  const beanCount = ${beanCount};`,
  ];
}

// 框架侧观测的接线（RFC 0011 C2/C3/C6，L6【已定】的两命名空间划分）。
//
// 容器面的三件事——崩溃接管、关停日志、启动摘要与 bean 台账——都挂 reforce.context，装没装
// 引擎都要有；web 面的请求日志与 500 兜底挂 reforce.web，装了引擎才有。此前只有后者，
// 于是 job / CLI / worker 这类应用一条运行期框架输出都拿不到。
function frameworkLoggingLines(): readonly string[] {
  return [
    "let frameworkLoggingValue;",
    "",
    // 生成的 bootstrap 是唯一同时拿得到框架 logger 与 LoggerFactory 的地方，而它不认识
    // @reforce/runtime。导出取值函数而不是常量——模块求值时容器还不存在。
    "export function frameworkLogging() {",
    "  return frameworkLoggingValue;",
    "}",
    "",
  ];
}

function contextLogWiringLines(): readonly string[] {
  return [
    "  const contextLog = application.get(contextLogger);",
    "  frameworkLoggingValue = { logger: contextLog, factory: application.get(loggerFactory) };",
    // 逐 bean 台账走 debug，与摘要里那条折叠的 slow beans 分开：一个是「哪几条慢」的结论，
    // 一个是要它时才付钱的全量明细。
    "  emitBeanTimings({ logger: contextLog, timings: startReport.beanTimings });",
  ];
}

// 无引擎应用的摘要：只有 context 与 slow beans 两节，ready 由 emitStartupSummary 自己补。
// 没有 onReady 回调可挂，所以就地发——容器 start 完成即"装配好了"。
function plainSummaryLines(): readonly string[] {
  return [
    "  emitStartupSummary({",
    "    logger: contextLog,",
    "    summary: {",
    "      sections: [",
    `        ...contextStartupSections({ beanCount, contextMs }, ${JSON.stringify(contextFrameworkLoggerName)}),`,
    `        ...beanTimingSections(startReport.beanTimings, ${JSON.stringify(contextFrameworkLoggerName)}),`,
    "      ],",
    "      startedAt,",
    "      readyAt: Date.now(),",
    "    },",
    "  });",
  ];
}

function startupSummaryLines(): readonly string[] {
  return [
    // 启动摘要的生产者（RFC 0011 D2）：web 侧事实由 connectWebApplication 回调交出，
    // bean 数与 context 耗时只有这里知道，两半在这一处合成。摘要整体归 context logger——
    // 里面只有 routes/engines 两节是 web 的事实，容器与台账都不是。
    "    onReady: (facts) =>",
    "      emitStartupSummary({",
    "        logger: contextLog,",
    "        summary: {",
    "          sections: [",
    `            ...contextStartupSections({ beanCount, contextMs }, ${JSON.stringify(contextFrameworkLoggerName)}),`,
    "            ...webStartupSections(facts),",
    `            ...beanTimingSections(startReport.beanTimings, ${JSON.stringify(contextFrameworkLoggerName)}),`,
    "          ],",
    "          startedAt,",
    "          readyAt: Date.now(),",
    "        },",
    "      }),",
  ];
}

// 容器面可观测 = 有 reforce.context bean + 有 LoggerFactory。两者由同一个条件产生
// （logger-synthesis 的 `provided !== undefined` 分支），分开写只是为了让类型收窄成立。
function isObserved(logging: LoggingExports): boolean {
  return logging.contextLogger !== undefined && logging.loggerFactory !== undefined;
}

// web 面可观测：在容器面之上再要一条 reforce.web bean，也就是真装了引擎。
function isSummarised(web: WebModel, logging: LoggingExports): boolean {
  return web.engines.length > 0 && isObserved(logging) && logging.frameworkLogger !== undefined;
}

function loggingImportLines(logging: LoggingExports): readonly string[] {
  const observed = isObserved(logging);
  const names = [
    ...(observed ? ["beanTimingSections", "contextStartupSections"] : []),
    ...(logging.loggerFactory === undefined ? [] : ["drainBootstrapLogs"]),
    ...(observed ? ["emitBeanTimings"] : []),
    ...(logging.loggerFactory === undefined ? [] : ["emitStartupSummary", "replayBootstrapLogs"]),
  ];
  return names.length === 0
    ? []
    : [`import { ${names.join(", ")} } from "${loggingRuntimeModuleSpecifier}";`];
}

function beansImportLine(logging: LoggingExports): string {
  const names = [
    "applicationDefinition",
    ...(logging.contextLogger === undefined ? [] : ["contextLogger"]),
    ...(logging.frameworkLogger === undefined ? [] : ["frameworkLogger"]),
    ...(logging.loggerFactory === undefined ? [] : ["loggerFactory"]),
  ];
  return `import { ${names.join(", ")} } from "./beans.js";`;
}

function webBootstrapImports(
  web: WebModel,
  generatedDirectory: string,
  logging: LoggingExports,
  summarised: boolean,
): readonly string[] {
  const seeder = web.requestSeeder;
  const webImportNames = ["connectWebApplication", ...(summarised ? ["webStartupSections"] : [])];
  return [
    `import { createApplicationContext } from "${contextRuntimeModuleSpecifier}";`,
    `import { ${webImportNames.join(", ")} } from "${webRuntimeModuleSpecifier}";`,
    ...loggingImportLines(logging),
    ...web.engines.map(
      (engine, index) =>
        `import { ${engine.exportName} as webEngine${index} } from ${JSON.stringify(engine.moduleSpecifier)};`,
    ),
    ...(seeder === undefined
      ? []
      : [
          `import { ${seeder.exportName} as webSeeder0 } from ${JSON.stringify(runtimeSpecifier(generatedDirectory, seeder.source.absolutePath))};`,
        ]),
    beansImportLine(logging),
    `import { routeTable } from "./routes.js";`,
  ];
}

// 无引擎的应用：没装日志绑定时仍是零 import 的哑 bootstrap，逐字节不变；装了绑定就与 web
// 分支拿到同一套容器面观测（RFC 0011 L6【已定】），只是没有 routes/engines 两节。
function renderPlainBootstrap(logging: LoggingExports, startLines: readonly string[]): string {
  const observed = isObserved(logging);
  return `${[
    `import { createApplicationContext } from "${contextRuntimeModuleSpecifier}";`,
    ...loggingImportLines(logging),
    beansImportLine(logging),
    "",
    ...(observed ? frameworkLoggingLines() : []),
    "export async function bootstrap() {",
    ...startLines,
    ...(observed ? contextLogWiringLines() : []),
    ...(observed ? plainSummaryLines() : []),
    "  return application;",
    "}",
  ].join("\n")}\n`;
}

function renderBootstrap(
  web: WebModel,
  generatedDirectory: string,
  logging: LoggingExports,
  beanCount: number,
): string {
  const startLines = contextStartLines(logging, beanCount);
  if (web.engines.length === 0) {
    return renderPlainBootstrap(logging, startLines);
  }
  const summarised = isSummarised(web, logging);
  const seeder = web.requestSeeder;
  const engineList = web.engines.map((_, index) => `webEngine${index}`).join(", ");
  return `${[
    ...webBootstrapImports(web, generatedDirectory, logging, summarised),
    "",
    ...(summarised ? frameworkLoggingLines() : []),
    "export async function bootstrap() {",
    ...startLines,
    ...(summarised ? contextLogWiringLines() : []),
    ...(summarised ? ["  const frameworkLog = application.get(frameworkLogger);"] : []),
    "  return await connectWebApplication({",
    "    context: application,",
    "    table: routeTable,",
    `    engines: [${engineList}],`,
    ...(seeder === undefined ? [] : ["    requestSeeds: webSeeder0,"]),
    // 请求日志与 500 兜底的 logger（RFC 0011 L6，#250）：容器 start 之后才取，取的是框架
    // 自己那条 logger bean。没装任何日志绑定的应用这一行不存在，web 核心照旧不打。
    ...(summarised ? ["    logger: frameworkLog,"] : []),
    ...(summarised ? startupSummaryLines() : []),
    "  });",
    "}",
  ].join("\n")}\n`;
}

export function generateFiles(
  project: ResolvedApplicationProject,
  providers: readonly BeanProviderModel[],
  configs: readonly ConfigProviderModel[],
  plans: ExecutionPlansModel,
  web: WebModel,
  weaving: WeavingModel,
  typeResolver: EmissionTypeResolver,
): readonly GeneratedFile[] {
  const generatedDirectory = generatedDirectoryPath(project.projectRoot);
  return Object.freeze([
    {
      path: "beans.ts",
      content: renderBeans(providers, configs, plans, weaving, generatedDirectory, typeResolver),
    },
    {
      path: "qualifiers.d.ts",
      content: renderQualifiers(providers, generatedDirectory),
    },
    {
      path: "manifest.json",
      content: renderManifest(providers, configs, plans, generatedDirectory),
    },
    {
      path: "bootstrap.ts",
      content: renderBootstrap(
        web,
        generatedDirectory,
        loggingExports(providers),
        providers.length,
      ),
    },
    ...generateWebFiles(project, web),
    generateWeavingFile(weaving),
  ]);
}
