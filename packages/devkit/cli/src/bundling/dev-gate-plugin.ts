import { type Rspack, rspack } from "@rsbuild/core";
import type { DevCompilerGate, DevCompilerGateResult } from "@/dev/compiler-gate";

function addWatchInputs(compilation: Rspack.Compilation, result: DevCompilerGateResult): void {
  compilation.fileDependencies.addAll(result.watchInputs.fileDependencies);
  compilation.contextDependencies.addAll(result.watchInputs.contextDependencies);
  compilation.missingDependencies.addAll(result.watchInputs.missingDependencies);
}

// 按 severity 分流（RFC 0011 OM2，#242）：把 warning 推进 compilation.errors 会让 rspack 判定
// 构建失败，dev 的健康子进程会被无谓地拦下——而 warning 的前提正是图完整、产物可用。
function addGateErrors(compilation: Rspack.Compilation, result: DevCompilerGateResult): void {
  if (result.status === "error") {
    compilation.errors.push(
      new rspack.WebpackError("Reforce compiler gate failed", { cause: result.error }),
    );
    return;
  }
  for (const diagnostic of result.diagnostics) {
    const rendered = new rspack.WebpackError(`[${diagnostic.code}] ${diagnostic.message}`);
    if (diagnostic.severity === "error") {
      compilation.errors.push(rendered);
      continue;
    }
    compilation.warnings.push(rendered);
  }
}

export class ReforceCompilerGatePlugin {
  private readonly gate: DevCompilerGate;
  private readonly generatedModules: readonly string[];
  private currentValue: DevCompilerGateResult | undefined;
  private compilerValue: Rspack.Compiler | undefined;
  private knownWatchFiles = new Set<string>();

  constructor(gate: DevCompilerGate, generatedModules: readonly string[]) {
    this.gate = gate;
    this.generatedModules = generatedModules;
  }

  get current(): DevCompilerGateResult | undefined {
    return this.currentValue;
  }

  get compiler(): Rspack.Compiler | undefined {
    return this.compilerValue;
  }

  apply(compiler: Rspack.Compiler): void {
    this.compilerValue = compiler;
    compiler.hooks.beforeCompile.tapPromise("ReforceCompilerGate", () =>
      this.prepareCompilation(compiler),
    );
    compiler.hooks.thisCompilation.tap("ReforceCompilerGate", (compilation) => {
      const current = this.currentValue;
      if (!current) {
        compilation.errors.push(new rspack.WebpackError("Reforce compiler gate did not run."));
        return;
      }
      addWatchInputs(compilation, current);
      addGateErrors(compilation, current);
    });
  }

  private async prepareCompilation(compiler: Rspack.Compiler): Promise<void> {
    const initial = this.gate.takeInitialResult();
    this.currentValue = initial ?? (await this.gate.compileNext());
    if (initial === undefined) {
      this.markModifiedFiles(compiler, this.currentValue);
    }
    this.knownWatchFiles = new Set(this.currentValue.watchInputs.fileDependencies);
  }

  private markModifiedFiles(compiler: Rspack.Compiler, current: DevCompilerGateResult): void {
    const modifiedFiles = new Set(compiler.modifiedFiles);
    if (current.status === "success") {
      for (const generatedModule of this.generatedModules) {
        modifiedFiles.add(generatedModule);
      }
    }
    for (const watchFile of current.watchInputs.fileDependencies) {
      if (!this.knownWatchFiles.has(watchFile)) {
        modifiedFiles.add(watchFile);
      }
    }
    compiler.modifiedFiles = modifiedFiles;
  }
}
