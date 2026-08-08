import { join } from "node:path";
import type { CompilerDiagnostic, GeneratedFile } from "@reforce/compiler";
import { compareUtf16CodeUnits, isPathContained } from "@reforce/primitives";
import type { Compiler, CompilerWatchInputs, ResolvedProject } from "@/compiler-types";

interface GeneratedOutputCommitter {
  commitGenerated(files: readonly GeneratedFile[]): Promise<void>;
}

export type DevCompilerGateResult =
  | {
      // 成功也可能带诊断，且必然全是 warning（RFC 0011 OM2，#242）。
      readonly status: "success";
      readonly diagnostics: readonly CompilerDiagnostic[];
      readonly watchInputs: CompilerWatchInputs;
    }
  | {
      readonly status: "failure";
      readonly diagnostics: readonly CompilerDiagnostic[];
      readonly watchInputs: CompilerWatchInputs;
    }
  | {
      readonly status: "error";
      readonly error: unknown;
      readonly watchInputs: CompilerWatchInputs;
    };

interface DevCompilerGateOptions {
  readonly compiler: Compiler;
  readonly projectDirectory: string;
  readonly tsconfigPath?: string;
  readonly project: ResolvedProject;
  readonly initialWatchInputs: CompilerWatchInputs;
  // Install 信号（应用 package.json、pnpm-lock.yaml，见 dev/install-signals）不来自编译器，但必须与
  // 编译器 watch 输入走同一条并集路径，才能经 gate 插件进入 rspack watcher、触发同一条
  // 「重发现→重链接→重生成」链（ADR 0004 决策 17，Issue #148）。
  readonly installSignalInputs?: CompilerWatchInputs;
  readonly generatedOutput: GeneratedOutputCommitter;
}

const emptyWatchInputs: CompilerWatchInputs = {
  fileDependencies: [],
  contextDependencies: [],
  missingDependencies: [],
};

function dedupeSorted(paths: readonly string[]): readonly string[] {
  return [...new Set(paths)].sort(compareUtf16CodeUnits);
}

function mergeWatchInputs(
  projectRoot: string,
  ...inputs: readonly CompilerWatchInputs[]
): CompilerWatchInputs {
  const generatedRoot = join(projectRoot, ".reforce");
  // 含自身变体：`.reforce` 目录本身也要被排除出 watch inputs，否则生成物写入会自触发重编译。
  const keep = (path: string) => !isPathContained(generatedRoot, path);
  return {
    fileDependencies: dedupeSorted(inputs.flatMap((input) => input.fileDependencies).filter(keep)),
    contextDependencies: dedupeSorted(
      inputs.flatMap((input) => input.contextDependencies).filter(keep),
    ),
    missingDependencies: dedupeSorted(
      inputs.flatMap((input) => input.missingDependencies).filter(keep),
    ),
  };
}

function changedProjectDiagnostic(): CompilerDiagnostic {
  return {
    kind: "compiler",
    code: "PROJECT_CONFIG_CHANGED",
    severity: "error",
    message: "The resolved application project changed while development watch was active.",
    related: [],
    help: "Stop the current development command and resolve the intended application again.",
  };
}

export class DevCompilerGate {
  private readonly compiler: Compiler;
  private readonly generatedOutput: GeneratedOutputCommitter;
  private readonly initialProject: ResolvedProject;
  private readonly projectDirectory: string;
  private readonly tsconfigPath: string | undefined;
  private readonly initialWatchInputs: CompilerWatchInputs;
  private stableWatchInputs: CompilerWatchInputs;
  private initialized = false;
  private initialResult: DevCompilerGateResult | undefined;

  constructor(options: DevCompilerGateOptions) {
    this.compiler = options.compiler;
    this.projectDirectory = options.projectDirectory;
    this.tsconfigPath = options.tsconfigPath;
    this.initialProject = options.project;
    this.initialWatchInputs = options.initialWatchInputs;
    this.stableWatchInputs = mergeWatchInputs(
      options.project.projectRoot,
      options.initialWatchInputs,
      options.installSignalInputs ?? emptyWatchInputs,
    );
    this.generatedOutput = options.generatedOutput;
  }

  async initialize(): Promise<DevCompilerGateResult> {
    if (this.initialized) {
      throw new Error("The development compiler gate can only initialize once.");
    }
    this.initialized = true;
    this.initialResult = await this.compile(this.initialProject, this.initialWatchInputs);
    return this.initialResult;
  }

  takeInitialResult(): DevCompilerGateResult | undefined {
    const result = this.initialResult;
    this.initialResult = undefined;
    return result;
  }

  async compileNext(): Promise<DevCompilerGateResult> {
    try {
      const resolution = await this.compiler.resolveProject({
        projectDirectory: this.projectDirectory,
        tsconfigPath: this.tsconfigPath,
      });
      if (resolution.status === "failure") {
        return {
          status: "failure",
          diagnostics: resolution.diagnostics,
          watchInputs: this.rememberWatchInputs(resolution.watchInputs),
        };
      }
      if (
        resolution.project.projectRoot !== this.initialProject.projectRoot ||
        resolution.project.tsconfigPath !== this.initialProject.tsconfigPath
      ) {
        return {
          status: "failure",
          diagnostics: [changedProjectDiagnostic()],
          watchInputs: this.rememberWatchInputs(resolution.watchInputs),
        };
      }
      return await this.compile(resolution.project, resolution.watchInputs);
    } catch (error) {
      return { status: "error", error, watchInputs: this.stableWatchInputs };
    }
  }

  // 合并是并集且只增不减，构造函数已经把 initialWatchInputs 并进 stableWatchInputs，所以这里不必再带
  // 上它——每次编译都重复过滤、去重、排序同一份初始依赖（数量级是整个 tsconfig 的 program files）。
  private rememberWatchInputs(...inputs: readonly CompilerWatchInputs[]): CompilerWatchInputs {
    this.stableWatchInputs = mergeWatchInputs(
      this.initialProject.projectRoot,
      this.stableWatchInputs,
      ...inputs,
    );
    return this.stableWatchInputs;
  }

  private async compile(
    project: ResolvedProject,
    resolutionWatchInputs: CompilerWatchInputs,
  ): Promise<DevCompilerGateResult> {
    try {
      const compilation = await this.compiler.compile({ project });
      const watchInputs = this.rememberWatchInputs(resolutionWatchInputs, compilation.watchInputs);
      if (compilation.status === "failure") {
        return { status: "failure", diagnostics: compilation.diagnostics, watchInputs };
      }
      await this.generatedOutput.commitGenerated(compilation.files);
      return { status: "success", diagnostics: compilation.diagnostics, watchInputs };
    } catch (error) {
      return {
        status: "error",
        error,
        watchInputs: this.rememberWatchInputs(resolutionWatchInputs),
      };
    }
  }
}
