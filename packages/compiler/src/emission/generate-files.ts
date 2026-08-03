import path from "node:path";
import { compareUtf16CodeUnits, toPortablePath } from "@reforce/primitives";
import stableStringify from "json-stable-stringify";
import { type ExecutionPlansModel, type ProviderModel, sourceReference } from "@/analysis/model";
import type { GeneratedFile, ResolvedApplicationProject } from "@/api";
import type { LinkedSymbol } from "@/linking/project-linker";
import { generatedDirectoryPath } from "@/project/generated-paths";

const contextModuleSpecifier = "@reforce/context";
const contextRuntimeModuleSpecifier = "@reforce/context/generated-runtime";

// Ordered most- to least-specific: "x.d.mts" also ends with ".mts", so the declaration suffixes
// must be matched before their plain counterparts.
const runtimeExtensionMap = [
  [".d.mts", ".mjs"],
  [".d.cts", ".cjs"],
  [".d.ts", ".js"],
  [".mts", ".mjs"],
  [".cts", ".cjs"],
  [".tsx", ".js"],
  [".ts", ".js"],
] as const;

function runtimeSuffix(file: string): string {
  for (const [sourceExtension, runtimeExtension] of runtimeExtensionMap) {
    if (file.endsWith(sourceExtension)) {
      return `${file.slice(0, -sourceExtension.length)}${runtimeExtension}`;
    }
  }
  return file;
}

function runtimeSpecifier(generatedDirectory: string, sourceFile: string): string {
  const relative = toPortablePath(path.relative(generatedDirectory, sourceFile));
  const withPrefix = relative.startsWith(".") ? relative : `./${relative}`;
  return runtimeSuffix(withPrefix);
}

function json(value: unknown): string {
  const rendered = stableStringify(value, { space: 2 });
  if (rendered === undefined) {
    throw new Error("Generated data is not serializable");
  }
  return rendered;
}

function indent(value: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return value
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function inlineJson(value: unknown, spaces: number): string {
  return indent(json(value), spaces).trimStart();
}

function sourceReferenceForSymbol(symbol: LinkedSymbol) {
  const span = symbol.declaration?.span;
  return span === undefined ? undefined : sourceReference(span);
}

function symbolReference(
  symbol: LinkedSymbol,
  generatedDirectory: string,
): Record<string, unknown> {
  const moduleSpecifier =
    symbol.source === undefined
      ? symbol.moduleSpecifier
      : runtimeSpecifier(generatedDirectory, symbol.source.absolutePath);
  const declaration = sourceReferenceForSymbol(symbol);
  return {
    displayName: symbol.name,
    moduleSpecifier,
    exportName: symbol.name,
    ...(declaration === undefined ? {} : { declaration }),
  };
}

function registrationExpression(provider: ProviderModel, index: number): string {
  const alias = `beanTarget${index}`;
  if (provider.kind === "factory") {
    return `const registration${index} = factoryBean({\n  id: ${JSON.stringify(provider.id)},\n  source: ${inlineJson(provider.declarationSource, 2)},\n  definition: ${alias},\n});`;
  }
  const argumentsList = provider.dependencies
    .toSorted((left, right) => left.parameterIndex - right.parameterIndex)
    .map((dependency) =>
      dependency.mode === "explicit-lazy"
        ? `resolver.lazy(${dependency.parameterIndex})`
        : `resolver.resolve(${dependency.parameterIndex})`,
    )
    .join(", ");
  const hooks = [
    ...(provider.startHook ? ["start: (bean) => bean.onContextStart(),"] : []),
    ...(provider.closeHook ? ["close: (bean) => bean.onContextClose(),"] : []),
  ];
  const hooksBlock =
    hooks.length === 0 ? "{}" : `{\n${hooks.map((line) => `    ${line}`).join("\n")}\n  }`;
  return `const registration${index} = classBean({\n  id: ${JSON.stringify(provider.id)},\n  source: ${inlineJson(provider.declarationSource, 2)},\n  target: ${alias},\n  dependencies: ${inlineJson(provider.dependencies, 2)},\n  create: (resolver) => new ${alias}(${argumentsList}),\n  hooks: ${hooksBlock},\n});`;
}

function renderBeans(
  providers: readonly ProviderModel[],
  plans: ExecutionPlansModel,
  generatedDirectory: string,
): string {
  const imports = providers.map((provider, index) => {
    const specifier = runtimeSpecifier(generatedDirectory, provider.source.absolutePath);
    return `import { ${provider.exportName} as beanTarget${index} } from ${JSON.stringify(specifier)};`;
  });
  const registrations = providers.map(registrationExpression);
  const names = providers.map((_, index) => `registration${index}`).join(", ");
  return `${[
    `import { classBean, factoryBean } from "${contextRuntimeModuleSpecifier}";`,
    `import type { GeneratedApplicationDefinition } from "${contextRuntimeModuleSpecifier}";`,
    ...imports,
    "",
    ...registrations.flatMap((registration) => [registration, ""]),
    "export const applicationDefinition = {",
    "  schemaVersion: 1,",
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
  providers: readonly ProviderModel[],
  plans: ExecutionPlansModel,
  generatedDirectory: string,
): string {
  const beans = providers.map((provider) => ({
    id: provider.id,
    kind: provider.kind,
    source: provider.declarationSource,
    runtimeExport: {
      moduleSpecifier: runtimeSpecifier(generatedDirectory, provider.source.absolutePath),
      exportName: provider.exportName,
    },
    provides: provider.provides.map((symbol) => symbolReference(symbol, generatedDirectory)),
    dependencies: provider.dependencies,
    primary: provider.primary,
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
  return `${json({ schemaVersion: 1, beans, plans })}\n`;
}

function renderBootstrap(): string {
  return `import { createApplicationContext } from "${contextRuntimeModuleSpecifier}";\nimport { applicationDefinition } from "./beans.js";\n\nexport async function bootstrap() {\n  const application = createApplicationContext(applicationDefinition);\n  await application.start();\n  return application;\n}\n`;
}

export function generateFiles(
  project: ResolvedApplicationProject,
  providers: readonly ProviderModel[],
  plans: ExecutionPlansModel,
): readonly GeneratedFile[] {
  const generatedDirectory = generatedDirectoryPath(project.projectRoot);
  return Object.freeze([
    {
      path: "beans.ts",
      content: renderBeans(providers, plans, generatedDirectory),
    },
    {
      path: "qualifiers.d.ts",
      content: renderQualifiers(providers, generatedDirectory),
    },
    {
      path: "manifest.json",
      content: renderManifest(providers, plans, generatedDirectory),
    },
    { path: "bootstrap.ts", content: renderBootstrap() },
  ]);
}
