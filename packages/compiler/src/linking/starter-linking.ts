import { readFile } from "node:fs/promises";
import path from "node:path";
import type { GeneratedSourceReferenceModel } from "@/analysis/model";
import type { CompilerDiagnostic } from "@/api";
import { diagnostic } from "@/diagnostics";
import type { StarterSymbolAnchor, StarterSymbolTable } from "@/linking/external-modules";
import type { LinkedSymbol } from "@/linking/model";
import type { ModuleRecord, ResolvedModule } from "@/linking/module-resolver";
import { moduleKey } from "@/linking/module-resolver";
import type { PackageLocator } from "@/linking/package-locator";
import {
  parseContractCoordinate,
  parseStarterMeta,
  type StarterMeta,
  type StarterMetaBean,
  starterMetaSubpath,
} from "@/linking/starter-meta";
import type { EntityName } from "@/parser/source-ir";
import type { SourceSpan } from "@/parser/source-location";
import type { ParsedSource } from "@/project/source-files";

// Starter 注册与链接（ADR 0004，#120；M1 范围见 #145）：
// - 注册读取：defineApplication({ starters: [...] }) 静态字面量（决策 5），元素必须是 import 绑定的
//   标识符，包名取自 import specifier；传递 starter 沿 meta.starterDeps 自动拉入（决策 6）。
// - registry：按包根登记安装版 meta；同名包两份物理拷贝是两条登记（决策 10 不合并）。
// - linkage：meta bean 变成链接层候选。runtimeExport 与 provides 在注册期即交叉核对（决策 15，
//   防 meta 与 dist 漂移）；dependencies 的契约按需解析——不被拉入的 bean 连坏引用都不报错
//   （决策 11 按需拉取）。

export interface StarterRegistrationRead {
  readonly packageName: string;
  readonly specifier: string;
  readonly span: SourceSpan;
  readonly source: ParsedSource;
}

interface StarterAnchorEntry extends StarterSymbolAnchor {
  readonly file: string;
  readonly exportName: string;
}

export interface RegisteredStarter {
  readonly packageName: string;
  readonly version: string;
  readonly rootPath: string;
  readonly metaPath: string;
  readonly meta: StarterMeta;
  readonly registration: StarterRegistrationRead;
  readonly anchorsByLocation: ReadonlyMap<string, StarterSymbolAnchor>;
  readonly anchorsById: ReadonlyMap<string, StarterAnchorEntry>;
}

export interface StarterRegistry extends StarterSymbolTable {
  readonly starters: readonly RegisteredStarter[];
  starterByRoot(rootPath: string): RegisteredStarter | undefined;
}

export interface StarterBeanModel {
  readonly id: string;
  readonly packageName: string;
  readonly origin: string;
  readonly rootPath: string;
  readonly runtimeExport: { readonly module: string; readonly export: string };
  readonly provides: readonly LinkedSymbol[];
  readonly dependencies: readonly { readonly index: number; readonly contract: string }[];
  readonly defaultBean: boolean;
  readonly root: boolean;
  readonly lifecycle: { readonly start: boolean; readonly close: boolean };
  readonly metaSource: GeneratedSourceReferenceModel;
  readonly sourceText: string;
}

export interface StarterLinkage {
  readonly beans: readonly StarterBeanModel[];
  resolveContract(bean: StarterBeanModel, coordinate: string): LinkedSymbol | undefined;
  contractImportSpecifier(symbol: LinkedSymbol): string | undefined;
}

export const emptyStarterLinkage: StarterLinkage = {
  beans: [],
  resolveContract: () => undefined,
  contractImportSpecifier: () => undefined,
};

function packageNameOfSpecifier(specifier: string): string | undefined {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.includes("\\")) {
    return undefined;
  }
  const segments = specifier.split("/");
  if (segments.some((segment) => segment.length === 0)) {
    return undefined;
  }
  if (specifier.startsWith("@")) {
    return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : undefined;
  }
  return segments[0];
}

function invalidDefineApplication(
  message: string,
  span: SourceSpan,
  related: readonly { readonly message: string; readonly sourceSpan?: SourceSpan }[] = [],
): CompilerDiagnostic {
  return diagnostic({
    code: "INVALID_DEFINE_APPLICATION",
    message,
    sourceSpan: span,
    related,
    help: "Declare one top-level defineApplication({ starters: [...] }) with a static array of imported starter handles.",
  });
}

interface DefineApplicationSite {
  readonly source: ParsedSource;
  readonly record: ModuleRecord;
  readonly declaration: ParsedSource["unit"]["applicationDefinitions"][number];
}

function collectDefineApplicationSites(
  sources: readonly ParsedSource[],
  recordFor: (source: ParsedSource) => ModuleRecord,
  resolveCallee: (record: ModuleRecord, callee: EntityName) => LinkedSymbol | undefined,
): readonly DefineApplicationSite[] {
  const sites: DefineApplicationSite[] = [];
  for (const source of sources) {
    if (source.sourceKind.startsWith("d.")) {
      continue;
    }
    const record = recordFor(source);
    for (const declaration of source.unit.applicationDefinitions) {
      const callee = resolveCallee(record, declaration.callee);
      if (callee?.kind === "context" && callee.name === "defineApplication") {
        sites.push({ source, record, declaration });
      }
    }
  }
  return sites;
}

function readSiteRegistrations(
  site: DefineApplicationSite,
  diagnostics: CompilerDiagnostic[],
): readonly StarterRegistrationRead[] {
  const { source, record, declaration } = site;
  if (!declaration.topLevel) {
    diagnostics.push(
      invalidDefineApplication(
        "defineApplication must be declared at module top level.",
        declaration.span,
      ),
    );
    return [];
  }
  if (declaration.options.kind !== "object") {
    diagnostics.push(
      invalidDefineApplication(
        "defineApplication options must be an inline object literal.",
        declaration.options.span,
      ),
    );
    return [];
  }
  const unsupported = declaration.options.properties.find(
    (property) => property.kind === "unsupported-property",
  );
  if (unsupported !== undefined) {
    diagnostics.push(
      invalidDefineApplication(
        "defineApplication only supports a literal starters option.",
        unsupported.span,
      ),
    );
    return [];
  }
  const starters = declaration.options.properties.find((property) => property.kind === "starters");
  if (starters?.kind !== "starters") {
    diagnostics.push(
      invalidDefineApplication(
        "defineApplication must declare starters.",
        declaration.options.span,
      ),
    );
    return [];
  }
  if (starters.value.kind !== "array") {
    diagnostics.push(
      invalidDefineApplication("starters must be a static array literal.", starters.value.span),
    );
    return [];
  }
  const registrations: StarterRegistrationRead[] = [];
  const byPackageName = new Map<string, StarterRegistrationRead>();
  for (const element of starters.value.elements) {
    if (element.kind !== "identifier") {
      diagnostics.push(
        invalidDefineApplication(
          "Each starters entry must be an identifier bound by an import declaration.",
          element.span,
        ),
      );
      continue;
    }
    const binding = record.imports.get(element.name);
    const packageName =
      binding === undefined ? undefined : packageNameOfSpecifier(binding.moduleSpecifier);
    if (binding === undefined || packageName === undefined) {
      diagnostics.push(
        invalidDefineApplication(
          `${element.name} must be imported from a starter package before it can be registered.`,
          element.span,
        ),
      );
      continue;
    }
    const existing = byPackageName.get(packageName);
    if (existing !== undefined) {
      diagnostics.push(
        diagnostic({
          code: "DUPLICATE_STARTER_REGISTRATION",
          message: `${packageName} is registered more than once.`,
          sourceSpan: element.span,
          related: [{ message: `first registration of ${packageName}`, sourceSpan: existing.span }],
          help: "Register each starter package exactly once.",
        }),
      );
      continue;
    }
    const registration: StarterRegistrationRead = {
      packageName,
      specifier: binding.moduleSpecifier,
      span: element.span,
      source,
    };
    byPackageName.set(packageName, registration);
    registrations.push(registration);
  }
  return registrations;
}

export function readStarterRegistrations(
  sources: readonly ParsedSource[],
  recordFor: (source: ParsedSource) => ModuleRecord,
  resolveCallee: (record: ModuleRecord, callee: EntityName) => LinkedSymbol | undefined,
  diagnostics: CompilerDiagnostic[],
): readonly StarterRegistrationRead[] {
  const sites = collectDefineApplicationSites(sources, recordFor, resolveCallee);
  if (sites.length > 1) {
    for (const site of sites) {
      diagnostics.push(
        invalidDefineApplication(
          "defineApplication must appear at most once per application.",
          site.declaration.span,
          sites
            .filter((other) => other !== site)
            .map((other) => ({
              message: `also declared in ${other.source.fileId}`,
              sourceSpan: other.declaration.span,
            })),
        ),
      );
    }
    return [];
  }
  const site = sites.at(0);
  return site === undefined ? [] : readSiteRegistrations(site, diagnostics);
}

interface StarterRegistryInputs {
  readonly registrations: readonly StarterRegistrationRead[];
  readonly resolveFromDirectory: (directory: string, specifier: string) => string | undefined;
  readonly locatePackage: PackageLocator;
  readonly diagnostics: CompilerDiagnostic[];
}

function anchorMaps(meta: StarterMeta): {
  readonly byLocation: ReadonlyMap<string, StarterSymbolAnchor>;
  readonly byId: ReadonlyMap<string, StarterAnchorEntry>;
} {
  const byLocation = new Map<string, StarterSymbolAnchor>();
  const byId = new Map<string, StarterAnchorEntry>();
  for (const symbol of meta.symbols) {
    const subpath = symbol.subpaths[0] ?? ".";
    byLocation.set(`${symbol.file}\0${symbol.exportName}`, { id: symbol.id, subpath });
    byId.set(symbol.id, {
      id: symbol.id,
      subpath,
      file: symbol.file,
      exportName: symbol.exportName,
    });
  }
  return { byLocation, byId };
}

async function readStarterMeta(
  metaPath: string,
  packageName: string,
  registration: StarterRegistrationRead,
  chain: string,
  diagnostics: CompilerDiagnostic[],
): Promise<StarterMeta | undefined> {
  let parsedBytes: unknown;
  try {
    parsedBytes = JSON.parse(await readFile(metaPath, "utf8"));
  } catch (error) {
    diagnostics.push(
      diagnostic({
        code: "INVALID_STARTER_META",
        message: `${packageName} reforce-meta is not readable JSON${chain}.`,
        sourceSpan: registration.span,
        help: "Rebuild and republish the starter package; its meta bytes are corrupt.",
        cause: error,
      }),
    );
    return undefined;
  }
  const parsed = parseStarterMeta(parsedBytes, packageName);
  if (parsed.status === "unsupported-version") {
    diagnostics.push(
      diagnostic({
        code: "UNSUPPORTED_STARTER_META_VERSION",
        message: `${packageName} reforce-meta declares schemaVersion ${parsed.foundVersion}; this compiler supports schemaVersion 1${chain}.`,
        sourceSpan: registration.span,
        help: "Upgrade the Reforce compiler or use a starter release with a compatible meta schema.",
      }),
    );
    return undefined;
  }
  if (parsed.status === "invalid") {
    diagnostics.push(
      diagnostic({
        code: "INVALID_STARTER_META",
        message: `${packageName} reforce-meta is invalid: ${parsed.reason}${chain}.`,
        sourceSpan: registration.span,
        help: "Rebuild the starter package with a compiler that produces schemaVersion 1 meta.",
      }),
    );
    return undefined;
  }
  return parsed.meta;
}

export async function loadStarterRegistry(inputs: StarterRegistryInputs): Promise<StarterRegistry> {
  const { registrations, resolveFromDirectory, locatePackage, diagnostics } = inputs;
  const byRoot = new Map<string, RegisteredStarter>();
  const starters: RegisteredStarter[] = [];

  async function loadStarter(
    packageName: string,
    fromDirectory: string,
    registration: StarterRegistrationRead,
    requiredBy: string | undefined,
  ): Promise<void> {
    const chain = requiredBy === undefined ? "" : ` (required by ${requiredBy})`;
    const metaPath = resolveFromDirectory(
      fromDirectory,
      `${packageName}${starterMetaSubpath.slice(1)}`,
    );
    if (metaPath === undefined) {
      diagnostics.push(
        diagnostic({
          code: "STARTER_META_NOT_FOUND",
          message: `Cannot resolve ${packageName}${starterMetaSubpath.slice(1)}${chain}.`,
          sourceSpan: registration.span,
          help: "Install the starter package and make sure it publishes the ./reforce-meta exports subpath.",
        }),
      );
      return;
    }
    const location = locatePackage(metaPath);
    if (location === undefined) {
      diagnostics.push(
        diagnostic({
          code: "STARTER_META_NOT_FOUND",
          message: `Cannot attribute ${packageName} reforce-meta to an installed package${chain}.`,
          sourceSpan: registration.span,
          help: "Reinstall the starter package; its package.json is missing or unreadable.",
        }),
      );
      return;
    }
    if (byRoot.has(location.rootPath)) {
      return;
    }
    const meta = await readStarterMeta(
      metaPath,
      location.packageName,
      registration,
      chain,
      diagnostics,
    );
    if (meta === undefined) {
      return;
    }
    const anchors = anchorMaps(meta);
    const starter: RegisteredStarter = {
      packageName: location.packageName,
      version: location.version,
      rootPath: location.rootPath,
      metaPath,
      meta,
      registration,
      anchorsByLocation: anchors.byLocation,
      anchorsById: anchors.byId,
    };
    byRoot.set(location.rootPath, starter);
    starters.push(starter);
    for (const dependency of meta.starterDeps) {
      await loadStarter(dependency, location.rootPath, registration, location.packageName);
    }
  }

  for (const registration of registrations) {
    await loadStarter(
      registration.packageName,
      path.dirname(registration.source.absolutePath),
      registration,
      undefined,
    );
  }

  return {
    starters,
    starterByRoot(rootPath) {
      return byRoot.get(rootPath);
    },
    anchorEntry(rootPath, file, exportName) {
      return byRoot.get(rootPath)?.anchorsByLocation.get(`${file}\0${exportName}`);
    },
  };
}

interface StarterLinkageInputs {
  readonly registry: StarterRegistry;
  readonly projectRoot: string;
  readonly diagnostics: CompilerDiagnostic[];
  readonly resolveFromDirectory: (directory: string, specifier: string) => string | undefined;
  readonly locatePackage: PackageLocator;
  readonly recordAt: (physicalPath: string) => ModuleRecord | undefined;
  readonly resolveModule: (
    source: ParsedSource,
    specifier: string,
    reportFailure?: boolean,
  ) => ResolvedModule | undefined;
  readonly resolveModuleExportFor: (
    target: ResolvedModule,
    exportedName: string,
  ) => LinkedSymbol | undefined;
}

function metaSourceText(starter: RegisteredStarter, source: GeneratedSourceReferenceModel): string {
  return `${starter.packageName}/${source.file}:${source.start.line + 1}:${source.start.character + 1}`;
}

// 外部模块闭包的种子（registry 部分）：meta 户口表锚定的定义文件、file 坐标指向的契约文件、
// 契约包与 runtime 模块的入口文件。闭包必须在 binder 之前装完，链接期的坐标解析才是同步查表。
interface SeedCollectionContext {
  readonly seeds: Set<string>;
  readonly resolveFromDirectory: (directory: string, specifier: string) => string | undefined;
  readonly locatePackage: PackageLocator;
  readonly resolveModule: StarterLinkageInputs["resolveModule"];
}

function collectFileCoordinateSeeds(
  starter: RegisteredStarter,
  coordinates: readonly string[],
  context: SeedCollectionContext,
): void {
  for (const coordinate of coordinates) {
    const parsed = parseContractCoordinate(coordinate);
    if (parsed?.kind !== "file") {
      continue;
    }
    const entry = context.resolveFromDirectory(starter.rootPath, parsed.packageName);
    if (entry === undefined) {
      continue;
    }
    context.seeds.add(entry);
    const location = context.locatePackage(entry);
    if (location !== undefined) {
      context.seeds.add(moduleKey(path.join(location.rootPath, parsed.file)));
    }
  }
}

function collectBeanSeeds(
  starter: RegisteredStarter,
  bean: StarterMetaBean,
  context: SeedCollectionContext,
): void {
  const runtimeTarget = context.resolveModule(
    starter.registration.source,
    bean.runtimeExport.module,
    false,
  );
  if (runtimeTarget !== undefined) {
    context.seeds.add(runtimeTarget.physicalPath);
  }
  collectFileCoordinateSeeds(
    starter,
    [...bean.provides, ...bean.dependencies.map((dependency) => dependency.contract)],
    context,
  );
}

export function starterSeedPaths(
  registry: StarterRegistry,
  resolveFromDirectory: (directory: string, specifier: string) => string | undefined,
  locatePackage: PackageLocator,
  resolveModule: StarterLinkageInputs["resolveModule"],
): readonly string[] {
  const seeds = new Set<string>();
  const context: SeedCollectionContext = {
    seeds,
    resolveFromDirectory,
    locatePackage,
    resolveModule,
  };
  for (const starter of registry.starters) {
    for (const symbol of starter.meta.symbols) {
      seeds.add(moduleKey(path.join(starter.rootPath, symbol.file)));
    }
    for (const bean of starter.meta.beans) {
      collectBeanSeeds(starter, bean, context);
    }
  }
  return [...seeds];
}

export function createStarterLinkage(inputs: StarterLinkageInputs): StarterLinkage {
  const {
    registry,
    projectRoot,
    diagnostics,
    resolveFromDirectory,
    locatePackage,
    recordAt,
    resolveModule,
    resolveModuleExportFor,
  } = inputs;

  function anchorSymbol(
    rootPath: string,
    file: string,
    exportName: string,
  ): LinkedSymbol | undefined {
    const physicalPath = moduleKey(path.join(rootPath, file));
    const record = recordAt(physicalPath);
    if (record === undefined) {
      return undefined;
    }
    return resolveModuleExportFor({ physicalPath, record }, exportName);
  }

  function starterRootFor(
    packageName: string,
    fromRootPath: string,
  ): RegisteredStarter | undefined {
    const metaPath = resolveFromDirectory(
      fromRootPath,
      `${packageName}${starterMetaSubpath.slice(1)}`,
    );
    if (metaPath === undefined) {
      return undefined;
    }
    const location = locatePackage(metaPath);
    return location === undefined ? undefined : registry.starterByRoot(location.rootPath);
  }

  function resolveContractFrom(
    starter: RegisteredStarter,
    coordinate: string,
  ): LinkedSymbol | undefined {
    const parsed = parseContractCoordinate(coordinate);
    if (parsed === undefined) {
      return undefined;
    }
    if (parsed.kind === "meta") {
      const owner =
        parsed.packageName === starter.packageName
          ? starter
          : starterRootFor(parsed.packageName, starter.rootPath);
      const anchor = owner?.anchorsById.get(`${parsed.packageName}#${parsed.exportName}`);
      if (owner === undefined || anchor === undefined) {
        return undefined;
      }
      return anchorSymbol(owner.rootPath, anchor.file, anchor.exportName);
    }
    const entry = resolveFromDirectory(starter.rootPath, parsed.packageName);
    const location = entry === undefined ? undefined : locatePackage(entry);
    if (location === undefined) {
      return undefined;
    }
    return anchorSymbol(location.rootPath, parsed.file, parsed.exportName);
  }

  function runtimeExportSymbol(
    starter: RegisteredStarter,
    bean: StarterMetaBean,
  ): LinkedSymbol | undefined {
    const target = resolveModule(starter.registration.source, bean.runtimeExport.module, false);
    if (target === undefined) {
      return undefined;
    }
    return resolveModuleExportFor(target, bean.runtimeExport.export);
  }

  function mismatch(starter: RegisteredStarter, bean: StarterMetaBean, detail: string): void {
    diagnostics.push(
      diagnostic({
        code: "STARTER_META_RUNTIME_MISMATCH",
        message: `${bean.id}: ${detail}`,
        sourceSpan: starter.registration.span,
        related: [{ message: metaSourceText(starter, bean.source) }],
        help: "The starter's reforce-meta and its published dist disagree; reinstall or upgrade the starter package.",
      }),
    );
  }

  function resolveProvidedContracts(
    starter: RegisteredStarter,
    bean: StarterMetaBean,
  ): readonly LinkedSymbol[] | undefined {
    const provides: LinkedSymbol[] = [];
    for (const coordinate of bean.provides) {
      const symbol = resolveContractFrom(starter, coordinate);
      if (symbol === undefined) {
        mismatch(starter, bean, `provides ${coordinate} which cannot be resolved.`);
        return undefined;
      }
      if (symbol.generic || (symbol.kind !== "class" && symbol.kind !== "interface")) {
        mismatch(
          starter,
          bean,
          `provides ${coordinate} which is not a non-generic class or interface.`,
        );
        return undefined;
      }
      provides.push(symbol);
    }
    return provides;
  }

  // 注册期交叉核对（决策 15）：runtimeExport 必须可解析成非泛型 class，provides 必须可解析成
  // 非泛型契约符号；不匹配的 bean 不进入候选，避免把发布事故拖成运行期错误。
  function buildBean(
    starter: RegisteredStarter,
    bean: StarterMetaBean,
  ): StarterBeanModel | undefined {
    const runtimeSymbol = runtimeExportSymbol(starter, bean);
    if (runtimeSymbol === undefined) {
      mismatch(
        starter,
        bean,
        `runtime export ${bean.runtimeExport.module}#${bean.runtimeExport.export} cannot be resolved from this application.`,
      );
      return undefined;
    }
    if (runtimeSymbol.kind !== "class" || runtimeSymbol.generic) {
      mismatch(
        starter,
        bean,
        `runtime export ${bean.runtimeExport.module}#${bean.runtimeExport.export} resolves to a ${runtimeSymbol.generic ? "generic " : ""}${runtimeSymbol.kind}, expected a non-generic class.`,
      );
      return undefined;
    }
    const provides = resolveProvidedContracts(starter, bean);
    if (provides === undefined) {
      return undefined;
    }
    return {
      id: bean.id,
      packageName: starter.packageName,
      origin: `${starter.packageName}@${starter.version}`,
      rootPath: starter.rootPath,
      runtimeExport: bean.runtimeExport,
      provides,
      dependencies: bean.dependencies.map((dependency, index) => ({
        index,
        contract: dependency.contract,
      })),
      defaultBean: bean.defaultBean,
      root: bean.role === "root",
      lifecycle: bean.lifecycle,
      metaSource: bean.source,
      sourceText: metaSourceText(starter, bean.source),
    };
  }

  const beans: StarterBeanModel[] = [];
  for (const starter of registry.starters) {
    for (const bean of starter.meta.beans) {
      const model = buildBean(starter, bean);
      if (model !== undefined) {
        beans.push(model);
      }
    }
  }

  const probeCache = new Map<string, string | undefined>();

  function probeRootImport(symbol: LinkedSymbol): string | undefined {
    const external = symbol.external;
    if (external === undefined) {
      return undefined;
    }
    if (probeCache.has(symbol.key)) {
      return probeCache.get(symbol.key);
    }
    const entry = resolveFromDirectory(projectRoot, external.packageName);
    const record = entry === undefined ? undefined : recordAt(entry);
    const resolved =
      entry === undefined || record === undefined
        ? undefined
        : resolveModuleExportFor({ physicalPath: entry, record }, symbol.name);
    const specifier = resolved?.key === symbol.key ? external.packageName : undefined;
    probeCache.set(symbol.key, specifier);
    return specifier;
  }

  return {
    beans,
    resolveContract(bean, coordinate) {
      const starter = registry.starterByRoot(bean.rootPath);
      return starter === undefined ? undefined : resolveContractFrom(starter, coordinate);
    },
    contractImportSpecifier(symbol) {
      if (symbol.external === undefined) {
        return undefined;
      }
      if (symbol.external.metaSubpath !== undefined) {
        return symbol.moduleSpecifier;
      }
      return probeRootImport(symbol);
    },
  };
}
