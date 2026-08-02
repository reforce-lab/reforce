import { isAbsolute, join, relative, sep } from "node:path";
import type { CompilerDiagnostic, GeneratedFile } from "@reforce/compiler";
import type { Compiler, CompilerWatchInputs, ResolvedProject } from "./compiler-types";
import { compareUtf16CodeUnits } from "./determinism";

export interface GeneratedOutputCommitter {
  commitGenerated(files: readonly GeneratedFile[]): Promise<void>;
}

export type DevCompilerGateResult =
  | {
      readonly status: "success";
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

export interface DevCompilerGateOptions {
  readonly compiler: Compiler;
  readonly projectDirectory: string;
  readonly tsconfigPath?: string;
  readonly project: ResolvedProject;
  readonly initialWatchInputs: CompilerWatchInputs;
  readonly generatedOutput: GeneratedOutputCommitter;
}

function isInside(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return (
    pathFromRoot === "" ||
    (!isAbsolute(pathFromRoot) && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`))
  );
}

function dedupeSorted(paths: readonly string[]): readonly string[] {
  return [...new Set(paths)].sort(compareUtf16CodeUnits);
}

function mergeWatchInputs(
  projectRoot: string,
  ...inputs: readonly CompilerWatchInputs[]
): CompilerWatchInputs {
  const generatedRoot = join(projectRoot, ".reforce");
  const keep = (path: string) => !isInside(generatedRoot, path);
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
  readonly #compiler: Compiler;
  readonly #generatedOutput: GeneratedOutputCommitter;
  readonly #initialProject: ResolvedProject;
  readonly #projectDirectory: string;
  readonly #tsconfigPath: string | undefined;
  readonly #initialWatchInputs: CompilerWatchInputs;
  #stableWatchInputs: CompilerWatchInputs;
  #initialized = false;
  #initialResult: DevCompilerGateResult | undefined;

  constructor(options: DevCompilerGateOptions) {
    this.#compiler = options.compiler;
    this.#projectDirectory = options.projectDirectory;
    this.#tsconfigPath = options.tsconfigPath;
    this.#initialProject = options.project;
    this.#initialWatchInputs = options.initialWatchInputs;
    this.#stableWatchInputs = mergeWatchInputs(
      options.project.projectRoot,
      options.initialWatchInputs,
    );
    this.#generatedOutput = options.generatedOutput;
  }

  async initialize(): Promise<DevCompilerGateResult> {
    if (this.#initialized) {
      throw new Error("The development compiler gate can only initialize once.");
    }
    this.#initialized = true;
    this.#initialResult = await this.#compile(this.#initialProject, this.#initialWatchInputs);
    return this.#initialResult;
  }

  takeInitialResult(): DevCompilerGateResult | undefined {
    const result = this.#initialResult;
    this.#initialResult = undefined;
    return result;
  }

  async compileNext(): Promise<DevCompilerGateResult> {
    try {
      const resolution = await this.#compiler.resolveProject({
        projectDirectory: this.#projectDirectory,
        ...(this.#tsconfigPath === undefined ? {} : { tsconfigPath: this.#tsconfigPath }),
      });
      if (resolution.status === "failure") {
        return {
          status: "failure",
          diagnostics: resolution.diagnostics,
          watchInputs: this.#rememberWatchInputs(resolution.watchInputs),
        };
      }
      if (
        resolution.project.projectRoot !== this.#initialProject.projectRoot ||
        resolution.project.tsconfigPath !== this.#initialProject.tsconfigPath
      ) {
        return {
          status: "failure",
          diagnostics: [changedProjectDiagnostic()],
          watchInputs: this.#rememberWatchInputs(resolution.watchInputs),
        };
      }
      return await this.#compile(resolution.project, resolution.watchInputs);
    } catch (error) {
      return { status: "error", error, watchInputs: this.#stableWatchInputs };
    }
  }

  #rememberWatchInputs(...inputs: readonly CompilerWatchInputs[]): CompilerWatchInputs {
    this.#stableWatchInputs = mergeWatchInputs(
      this.#initialProject.projectRoot,
      this.#initialWatchInputs,
      this.#stableWatchInputs,
      ...inputs,
    );
    return this.#stableWatchInputs;
  }

  async #compile(
    project: ResolvedProject,
    resolutionWatchInputs: CompilerWatchInputs,
  ): Promise<DevCompilerGateResult> {
    try {
      const compilation = await this.#compiler.compile({ project });
      const watchInputs = this.#rememberWatchInputs(resolutionWatchInputs, compilation.watchInputs);
      if (compilation.status === "failure") {
        return { status: "failure", diagnostics: compilation.diagnostics, watchInputs };
      }
      await this.#generatedOutput.commitGenerated(compilation.files);
      return { status: "success", watchInputs };
    } catch (error) {
      return {
        status: "error",
        error,
        watchInputs: this.#rememberWatchInputs(resolutionWatchInputs),
      };
    }
  }
}
