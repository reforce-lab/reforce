import { compareUtf16CodeUnits } from "@reforce/primitives";
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
import { generateWebFiles, webRuntimeModuleSpecifier } from "@/emission/generate-web-files";
import { inlineJson, json, runtimeSpecifier } from "@/emission/render";
import type { LinkedSymbol } from "@/linking/model";
import { generatedDirectoryPath } from "@/project/generated-paths";

const contextModuleSpecifier = "@reforce/context";
const contextRuntimeModuleSpecifier = "@reforce/context/generated-runtime";
const configRuntimeModuleSpecifier = "@reforce/config/generated-runtime";

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
      const specifier =
        symbol.source === undefined
          ? typeResolver.contractImportSpecifier(symbol)
          : runtimeSpecifier(generatedDirectory, symbol.source.absolutePath);
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

function registrationExpression(
  provider: BeanProviderModel,
  index: number,
  contracts: ReadonlyMap<string, ContractImport>,
): string {
  const alias = `beanTarget${index}`;
  // factoryBean 的 scope 由 defineBean 选项自证（同一字面量既是编译输入也是运行时输入），
  // 不重复写入；classBean 无处自证，scope 必须显式落进生成物（ADR 0006 W7）。
  if (provider.kind === "factory") {
    return `const registration${index} = factoryBean({\n  id: ${JSON.stringify(provider.id)},\n  source: ${inlineJson(provider.declarationSource, 2)},\n  definition: ${alias},\n});`;
  }
  const argumentsList = provider.dependencies
    .toSorted((left, right) => left.parameterIndex - right.parameterIndex)
    .map((dependency) => dependencyExpression(dependency, contracts))
    .join(", ");
  const hooks = [
    ...(provider.startHook ? ["start: (bean) => bean.onContextStart(),"] : []),
    ...(provider.closeHook ? ["close: (bean) => bean.onContextClose(),"] : []),
  ];
  const hooksBlock =
    hooks.length === 0 ? "{}" : `{\n${hooks.map((line) => `    ${line}`).join("\n")}\n  }`;
  return `const registration${index} = classBean({\n  id: ${JSON.stringify(provider.id)},\n  source: ${inlineJson(provider.declarationSource, 2)},\n  scope: ${JSON.stringify(provider.scope)},\n  target: ${alias},\n  dependencies: ${inlineJson(runtimeDependencies(provider), 2)},\n  create: (resolver) => new ${alias}(${argumentsList}),\n  hooks: ${hooksBlock},\n});`;
}

function renderBeans(
  providers: readonly BeanProviderModel[],
  configs: readonly ConfigProviderModel[],
  plans: ExecutionPlansModel,
  generatedDirectory: string,
  typeResolver: EmissionTypeResolver,
): string {
  const contracts = contractImports(providers, generatedDirectory, typeResolver);
  const runtimeImports = [
    `import { ${["classBean", ...(configs.length > 0 ? ["configBean"] : []), "factoryBean"].join(", ")} } from "${contextRuntimeModuleSpecifier}";`,
    `import type { GeneratedApplicationDefinition } from "${contextRuntimeModuleSpecifier}";`,
    // 无 config 的应用不引入 @reforce/config：该依赖只在声明了 config class 时才需要安装。
    ...(configs.length > 0
      ? [`import { createConfigBinding } from "${configRuntimeModuleSpecifier}";`]
      : []),
  ];
  const imports = providers.map((provider, index) => {
    const specifier = providerValueSpecifier(provider, generatedDirectory);
    return `import { ${provider.exportName} as beanTarget${index} } from ${JSON.stringify(specifier)};`;
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
  const registrations = providers.map((provider, index) =>
    registrationExpression(provider, index, contracts),
  );
  const names = providers.map((_, index) => `registration${index}`).join(", ");
  const configNames = configs.map((_, index) => `config${index}`).join(", ");
  return `${[
    ...runtimeImports,
    ...imports,
    ...configImports,
    ...typeImports,
    "",
    ...configRegistrations.flatMap((registration) => [registration, ""]),
    ...registrations.flatMap((registration) => [registration, ""]),
    "export const applicationDefinition = {",
    "  schemaVersion: 4,",
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
      exportName: provider.exportName,
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
  return `${json({ schemaVersion: 4, configs: manifestConfigs, beans, plans })}\n`;
}

// web 接线（ADR 0006 W2 的 #153 修订）：路由表与容器只有生成代码同时拿得到，注册了 web 引擎
// starter 时 bootstrap 负责把两者交给 connectWebApplication（组装 + 启动引擎 + 关闭编排）。
// 无引擎的应用保持零 import 的哑 bootstrap，逐字节不变。
function renderBootstrap(web: WebModel, generatedDirectory: string): string {
  if (web.engines.length === 0) {
    return `import { createApplicationContext } from "${contextRuntimeModuleSpecifier}";\nimport { applicationDefinition } from "./beans.js";\n\nexport async function bootstrap() {\n  const application = createApplicationContext(applicationDefinition);\n  await application.start();\n  return application;\n}\n`;
  }
  const seeder = web.requestSeeder;
  const imports = [
    `import { createApplicationContext } from "${contextRuntimeModuleSpecifier}";`,
    `import { connectWebApplication } from "${webRuntimeModuleSpecifier}";`,
    ...web.engines.map(
      (engine, index) =>
        `import { ${engine.exportName} as webEngine${index} } from ${JSON.stringify(engine.moduleSpecifier)};`,
    ),
    ...(seeder === undefined
      ? []
      : [
          `import { ${seeder.exportName} as webSeeder0 } from ${JSON.stringify(runtimeSpecifier(generatedDirectory, seeder.source.absolutePath))};`,
        ]),
    `import { applicationDefinition } from "./beans.js";`,
    `import { routeTable } from "./routes.js";`,
  ];
  const engineList = web.engines.map((_, index) => `webEngine${index}`).join(", ");
  return `${[
    ...imports,
    "",
    "export async function bootstrap() {",
    "  const application = createApplicationContext(applicationDefinition);",
    "  await application.start();",
    "  return await connectWebApplication({",
    "    context: application,",
    "    table: routeTable,",
    `    engines: [${engineList}],`,
    ...(seeder === undefined ? [] : ["    requestSeeds: webSeeder0,"]),
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
  typeResolver: EmissionTypeResolver,
): readonly GeneratedFile[] {
  const generatedDirectory = generatedDirectoryPath(project.projectRoot);
  return Object.freeze([
    {
      path: "beans.ts",
      content: renderBeans(providers, configs, plans, generatedDirectory, typeResolver),
    },
    {
      path: "qualifiers.d.ts",
      content: renderQualifiers(providers, generatedDirectory),
    },
    {
      path: "manifest.json",
      content: renderManifest(providers, configs, plans, generatedDirectory),
    },
    { path: "bootstrap.ts", content: renderBootstrap(web, generatedDirectory) },
    ...generateWebFiles(project, web),
  ]);
}
