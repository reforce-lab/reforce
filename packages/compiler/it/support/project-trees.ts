import type { ProjectTree } from "@reforce/tooling-testing";

function json(value: unknown): string {
  return `${JSON.stringify(value, undefined, 2)}\n`;
}

const compilerOptions = {
  target: "ESNext",
  module: "ESNext",
  moduleResolution: "Bundler",
  strict: true,
  experimentalDecorators: false,
  emitDecoratorMetadata: false,
};

export const positiveApplicationTree = {
  "package.json": json({
    name: "compiler-positive-application",
    private: true,
    type: "module",
  }),
  "tsconfig.json": json({
    compilerOptions: {
      ...compilerOptions,
      paths: { "@/*": ["./src/*"] },
    },
    include: ["src", ".reforce/generated/**/*.d.ts"],
  }),
  src: {
    "application.ts": ['export * from "@/greeting";', 'export * from "@/providers";', ""].join(
      "\n",
    ),
    "greeting.ts": [
      'import { Injectable, type OnContextClose, type OnContextStart } from "@reforce/core";',
      "export interface GreetingPort { value(): string; }",
      "@Injectable()",
      "export class MessageRepository implements GreetingPort {",
      '  value(): string { return "hello"; }',
      "}",
      "@Injectable()",
      "export class GreetingService implements OnContextStart, OnContextClose {",
      "  static readonly events: string[] = [];",
      "  constructor(private readonly repository: GreetingPort) {}",
      "  greet(): string { return this.repository.value(); }",
      '  onContextStart(): void { GreetingService.events.push("start"); }',
      '  onContextClose(): void { GreetingService.events.push("close"); }',
      "}",
      "",
    ].join("\n"),
    "providers.ts": [
      'import { Injectable, Primary, Qualifier } from "@reforce/core";',
      "export interface DefaultPort { value(): string; }",
      '@Injectable() @Qualifier("Fallback")',
      'export class FallbackProvider implements DefaultPort { value(): string { return "fallback"; } }',
      '@Injectable() @Primary() @Qualifier("Preferred")',
      'export class PreferredProvider implements DefaultPort { value(): string { return "preferred"; } }',
      "export interface UniquePort { value(): string; }",
      "@Injectable()",
      'export class UniqueProvider implements UniquePort { value(): string { return "unique"; } }',
      "",
    ].join("\n"),
  },
} satisfies ProjectTree;

function applicationConfig(): string {
  return json({
    compilerOptions,
    include: ["src", ".reforce/generated/**/*.d.ts"],
  });
}

const ambiguousLeafConfig = {
  "tsconfig.app.json": json({
    compilerOptions: {
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "Bundler",
    },
    include: ["src", ".reforce/generated/**/*.d.ts"],
  }),
  "tsconfig.worker.json": json({
    compilerOptions: {
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "Bundler",
    },
    include: ["src", ".reforce/generated/**/*.d.ts"],
  }),
  src: { "application.ts": 'export const application = "ambiguous";\n' },
} satisfies ProjectTree;

const computedLifecycleMethodRejected = {
  "tsconfig.json": applicationConfig(),
  src: {
    "application.ts": [
      'import { Injectable, type OnContextStart } from "@reforce/core";',
      "",
      "@Injectable()",
      "export class Service implements OnContextStart {",
      '  ["onContextStart"](): void {}',
      "}",
      "",
    ].join("\n"),
  },
} satisfies ProjectTree;

const deterministicCycleGeneration = {
  "tsconfig.json": json({
    compilerOptions: {
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "Bundler",
    },
    files: ["src/zeta.ts", "src/alpha.ts"],
    include: [".reforce/generated/**/*.d.ts"],
  }),
  src: {
    "alpha.ts": [
      'import { Injectable, type OnContextClose, type OnContextStart } from "@reforce/core";',
      'import { ZetaService } from "./zeta";',
      "",
      "@Injectable()",
      "export class AlphaService implements OnContextStart, OnContextClose {",
      "  constructor(readonly zeta: ZetaService) {}",
      "  onContextStart(): void {}",
      "  onContextClose(): void {}",
      "}",
      "",
    ].join("\n"),
    "zeta.ts": [
      'import { Injectable, type OnContextClose, type OnContextStart } from "@reforce/core";',
      'import { AlphaService } from "./alpha";',
      "",
      "@Injectable()",
      "export class ZetaService implements OnContextStart, OnContextClose {",
      "  constructor(readonly alpha: AlphaService) {}",
      "  onContextStart(): void {}",
      "  onContextClose(): void {}",
      "}",
      "",
    ].join("\n"),
  },
} satisfies ProjectTree;

const duplicateGeneratedQualifierMember = {
  "tsconfig.json": applicationConfig(),
  src: {
    "application.ts": [
      'import { Injectable } from "@reforce/core";',
      "",
      "export interface PaymentPort {}",
      "export namespace PaymentPort {",
      "  export interface PaymentService {}",
      "}",
      "@Injectable()",
      "export class PaymentService implements PaymentPort {}",
      "",
    ].join("\n"),
  },
} satisfies ProjectTree;

const generatedRuntimeContract = {
  "tsconfig.json": applicationConfig(),
  src: {
    "application.ts": [
      'import { defineBean, Injectable, type Lazy, type OnContextClose, type OnContextStart } from "@reforce/core";',
      'import { type AlphaPort, type BetaPort, ManagedResource } from "./contracts";',
      "",
      "@Injectable()",
      "export class AlphaService implements AlphaPort, OnContextStart, OnContextClose {",
      "  constructor(readonly beta: BetaService, readonly resource: Lazy<ManagedResource>) {}",
      "  alpha(): string { return this.beta.beta(); }",
      "  onContextStart(): void {}",
      "  onContextClose(): void {}",
      "}",
      "@Injectable()",
      "export class BetaService implements BetaPort {",
      "  constructor(readonly alpha: AlphaService) {}",
      '  beta(): string { return "beta"; }',
      "}",
      "export const managedResource = defineBean<ManagedResource>({",
      "  create: () => new ManagedResource(),",
      "  dispose: (resource) => resource.close(),",
      "});",
      "",
    ].join("\n"),
    "contracts.ts": [
      "export interface AlphaPort { alpha(): string; }",
      "export interface BetaPort { beta(): string; }",
      "export class ManagedResource { close(): void {} }",
      "",
    ].join("\n"),
  },
} satisfies ProjectTree;

const invalidLifecycleReturnRejected = {
  "tsconfig.json": applicationConfig(),
  src: {
    "application.ts": [
      'import { Injectable, type OnContextStart } from "@reforce/core";',
      "@Injectable()",
      "export class Service implements OnContextStart {",
      '  onContextStart(): string { return "invalid"; }',
      "}",
      "",
    ].join("\n"),
  },
} satisfies ProjectTree;

const legacyParameterDecoratorRejected = {
  "tsconfig.json": applicationConfig(),
  src: {
    "application.ts": [
      'import { Injectable, Qualifier } from "@reforce/core";',
      "export interface ServicePort {}",
      "@Injectable()",
      "export class Service {",
      '  constructor(@Qualifier("legacy") port: ServicePort) { void port; }',
      "}",
      "",
    ].join("\n"),
  },
} satisfies ProjectTree;

const monorepoApplicationSelection = {
  "package.json": json({ name: "compiler-monorepo-project", private: true, type: "module" }),
  "tsconfig.json": json({
    files: [],
    references: [{ path: "apps/api" }, { path: "apps/admin" }],
  }),
  "tsconfig.shared.json": json({ compilerOptions, files: [] }),
  apps: {
    admin: {
      "tsconfig.json": json({
        extends: "../../tsconfig.shared.json",
        include: ["src", ".reforce/generated/**/*.d.ts"],
      }),
      src: {
        "application.ts": [
          'import { Injectable } from "@reforce/core";',
          "@Injectable()",
          "export class AdminService {}",
          "",
        ].join("\n"),
      },
    },
    api: {
      "tsconfig.json": json({
        extends: "../../tsconfig.shared.json",
        compilerOptions: {
          baseUrl: ".",
          paths: { "@shared/path": ["../../packages/shared/src/path-contract.ts"] },
        },
        include: ["src", ".reforce/generated/**/*.d.ts"],
      }),
      src: {
        "application.ts": [
          'import type { ImportPort } from "@fixture/shared/import-contract";',
          'import { Injectable } from "@reforce/core";',
          'import type { ExportPort } from "@fixture/shared";',
          'import type { PathPort } from "@shared/path";',
          '@Injectable() export class ExportAdapter implements ExportPort { read(): string { return "export"; } }',
          '@Injectable() export class PathAdapter implements PathPort { path(): string { return "path"; } }',
          '@Injectable() export class ImportAdapter implements ImportPort { imported(): string { return "imports"; } }',
          "@Injectable() export class ApiService {",
          "  constructor(readonly exported: ExportPort, readonly pathed: PathPort, readonly imported: ImportPort) {}",
          "}",
          "",
        ].join("\n"),
      },
    },
  },
  packages: {
    shared: {
      "package.json": json({
        name: "@fixture/shared",
        version: "0.0.0",
        private: true,
        type: "module",
        exports: {
          ".": { types: "./src/index.ts", default: "./src/index.ts" },
          "./import-contract": {
            types: "./src/import-contract.ts",
            default: "./src/import-contract.ts",
          },
        },
      }),
      src: {
        "import-contract.ts": "export interface ImportPort { imported(): string; }\n",
        "index.ts": [
          'import { Injectable } from "@reforce/core";',
          "export interface ExportPort { read(): string; }",
          "@Injectable()",
          "export class HiddenSharedBean implements ExportPort {",
          '  read(): string { return "hidden"; }',
          "}",
          "",
        ].join("\n"),
        "path-contract.ts": "export interface PathPort { path(): string; }\n",
      },
    },
  },
} satisfies ProjectTree;

const namespaceExportContract = {
  "tsconfig.json": applicationConfig(),
  src: {
    "application.ts": [
      'import { Injectable } from "@reforce/core";',
      'import { Ports } from "./barrel";',
      "@Injectable() export class Provider implements Ports.Port {}",
      "@Injectable() export class Consumer { constructor(readonly port: Ports.Port) {} }",
      "",
    ].join("\n"),
    "barrel.ts": 'export * as Ports from "./ports";\n',
    "ports.ts": "export interface Port {}\n",
  },
} satisfies ProjectTree;

const nonInlineFactoryDisposerRejected = {
  "tsconfig.json": applicationConfig(),
  src: {
    "application.ts": [
      'import { defineBean } from "@reforce/core";',
      "export class Resource {}",
      "function cleanup(resource: Resource): void { void resource; }",
      "export const resource = defineBean<Resource>({",
      "  create: () => new Resource(),",
      "  dispose: cleanup,",
      "});",
      "",
    ].join("\n"),
  },
} satisfies ProjectTree;

const reservedQualifierRejected = {
  "tsconfig.json": applicationConfig(),
  src: {
    "application.ts": [
      'import { Injectable, Qualifier } from "@reforce/core";',
      "export interface JobPort {}",
      '@Qualifier("enum")',
      "@Injectable()",
      "export class JobService implements JobPort {}",
      "",
    ].join("\n"),
  },
} satisfies ProjectTree;

export const compilerProjectTrees = {
  "ambiguous-leaf-config": ambiguousLeafConfig,
  "computed-lifecycle-method-rejected": computedLifecycleMethodRejected,
  "deterministic-cycle-generation": deterministicCycleGeneration,
  "duplicate-generated-qualifier-member": duplicateGeneratedQualifierMember,
  "generated-runtime-contract": generatedRuntimeContract,
  "invalid-lifecycle-return-rejected": invalidLifecycleReturnRejected,
  "legacy-parameter-decorator-rejected": legacyParameterDecoratorRejected,
  "monorepo-application-selection": monorepoApplicationSelection,
  "namespace-export-contract": namespaceExportContract,
  "non-inline-factory-disposer-rejected": nonInlineFactoryDisposerRejected,
  "reserved-qualifier-rejected": reservedQualifierRejected,
} as const satisfies Readonly<Record<string, ProjectTree>>;

export type CompilerProjectName = keyof typeof compilerProjectTrees;
