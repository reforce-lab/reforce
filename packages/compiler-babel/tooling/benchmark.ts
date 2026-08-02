import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { type Compiler, createCompiler } from "@reforce/compiler";
import type { CompilerFrontend, FrontendInput } from "@reforce/compiler-spi";
import {
  copyFixtureTree,
  createTemporaryProject,
  readFixtureTree,
  runCommand,
  spawnCommand,
} from "@reforce/tooling-testing";
import { isObject } from "radashi";
import { compareUtf16CodeUnits } from "#internal/normalize";
import {
  fixtureDirectory,
  frontendFixtureNames,
  loadFrontendInputs,
} from "#tooling/fixture-corpus";

const warmupCount = 10;
const sampleCount = 30;
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

type FrontendId = "babel" | "yuku";

interface Measurement {
  readonly durationNanoseconds: number;
  readonly peakRssBytes: number;
}

interface WorkerMeasurements {
  readonly frontend: FrontendId;
  readonly cacheKey: string;
  readonly samples: readonly Measurement[];
}

interface FrontendMeasurements {
  readonly frontend: FrontendId;
  readonly cacheKey: string;
  readonly cold: readonly Measurement[];
  readonly incremental: readonly Measurement[];
  readonly coldP50Nanoseconds: number;
  readonly coldP95Nanoseconds: number;
  readonly incrementalP50Nanoseconds: number;
  readonly incrementalP95Nanoseconds: number;
  readonly peakRssBytes: number;
}

async function loadCorpus(): Promise<readonly FrontendInput[]> {
  return (await Promise.all((await frontendFixtureNames()).map(loadFrontendInputs))).flat();
}

async function frontendById(id: FrontendId): Promise<CompilerFrontend> {
  if (id === "babel") {
    const { babelFrontend } = await import("#internal/frontend");
    return babelFrontend;
  }
  const { yukuFrontend } = await import("@reforce/compiler-yuku");
  return yukuFrontend;
}

async function parseAdapterCorpus(
  frontend: CompilerFrontend,
  corpus: readonly FrontendInput[],
): Promise<void> {
  for (const input of corpus) {
    await frontend.parse(input);
  }
}

async function measureAdapter(
  frontend: CompilerFrontend,
  corpus: readonly FrontendInput[],
): Promise<Measurement> {
  let peakRssBytes = process.memoryUsage.rss();
  const start = process.hrtime.bigint();
  for (const input of corpus) {
    await frontend.parse(input);
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage.rss());
  }
  const end = process.hrtime.bigint();
  return { durationNanoseconds: Number(end - start), peakRssBytes };
}

function percentile(samples: readonly number[], percentileValue: number): number {
  const sorted = samples.toSorted((left, right) => left - right);
  const index = Math.ceil(percentileValue * sorted.length) - 1;
  return sorted[Math.max(0, index)] ?? 0;
}

function changedAdapterCorpus(
  corpus: readonly FrontendInput[],
  sampleIndex: number,
): readonly FrontendInput[] {
  return corpus.map((input, inputIndex) =>
    inputIndex === sampleIndex % corpus.length
      ? { ...input, sourceText: `${input.sourceText}\n// benchmark change ${sampleIndex}` }
      : input,
  );
}

async function adapterColdWorker(id: FrontendId): Promise<WorkerMeasurements> {
  const frontend = await frontendById(id);
  const corpus = await loadCorpus();
  return {
    frontend: id,
    cacheKey: frontend.cacheKey,
    samples: [await measureAdapter(frontend, corpus)],
  };
}

async function adapterIncrementalWorker(id: FrontendId): Promise<WorkerMeasurements> {
  const frontend = await frontendById(id);
  const corpus = await loadCorpus();
  for (let index = 0; index < warmupCount; index += 1) {
    await parseAdapterCorpus(frontend, corpus);
  }
  const samples: Measurement[] = [];
  for (let index = 0; index < sampleCount; index += 1) {
    samples.push(await measureAdapter(frontend, changedAdapterCorpus(corpus, index)));
  }
  return { frontend: id, cacheKey: frontend.cacheKey, samples };
}

function isMeasurement(value: unknown): value is Measurement {
  return (
    isObject(value) &&
    "durationNanoseconds" in value &&
    typeof value.durationNanoseconds === "number" &&
    "peakRssBytes" in value &&
    typeof value.peakRssBytes === "number"
  );
}

function isWorkerMeasurements(value: unknown): value is WorkerMeasurements {
  return (
    isObject(value) &&
    "frontend" in value &&
    (value.frontend === "babel" || value.frontend === "yuku") &&
    "cacheKey" in value &&
    typeof value.cacheKey === "string" &&
    "samples" in value &&
    Array.isArray(value.samples) &&
    value.samples.every(isMeasurement)
  );
}

function parseWorkerOutput(output: string): WorkerMeasurements {
  const value: unknown = JSON.parse(output);
  if (!isWorkerMeasurements(value)) {
    throw new TypeError("Benchmark worker returned an invalid result.");
  }
  return value;
}

async function runSelf(arguments_: readonly string[]): Promise<WorkerMeasurements> {
  const result = await runCommand(
    process.execPath,
    ["--conditions=development", import.meta.filename, ...arguments_],
    { cwd: process.cwd() },
  );
  if (result.exitCode !== 0 || typeof result.stdout !== "string") {
    throw new Error(`Benchmark worker failed with exit code ${result.exitCode}.`);
  }
  return parseWorkerOutput(result.stdout);
}

async function assertFrontendConformance(): Promise<void> {
  const corpus = await loadCorpus();
  const [babel, yuku] = await Promise.all([frontendById("babel"), frontendById("yuku")]);
  for (const input of corpus) {
    const [babelResult, yukuResult] = await Promise.all([babel.parse(input), yuku.parse(input)]);
    if (JSON.stringify(babelResult) !== JSON.stringify(yukuResult)) {
      throw new Error(`Frontend conformance differs for ${input.file}.`);
    }
  }
}

async function compilerFixtureNames(): Promise<readonly string[]> {
  const names: string[] = [];
  for (const entry of await readdir(fixtureDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const projectDirectory = path.join(fixtureDirectory, entry.name, "project");
    const projectEntries = await readdir(projectDirectory);
    if (projectEntries.some((name) => /^tsconfig.*\.json$/u.test(name))) {
      names.push(entry.name);
    }
  }
  return names.toSorted(compareUtf16CodeUnits);
}

async function copyCompilerCorpus(destinationRoot: string): Promise<readonly string[]> {
  const names = await compilerFixtureNames();
  const projectDirectories: string[] = [];
  for (const name of names) {
    const projectDirectory = path.join(destinationRoot, name);
    await copyFixtureTree(path.join(fixtureDirectory, name, "project"), projectDirectory);
    projectDirectories.push(projectDirectory);
  }
  return projectDirectories;
}

async function measureCompilerPipeline(
  frontend: CompilerFrontend,
  projectDirectories: readonly string[],
  compiler?: Compiler,
): Promise<Measurement> {
  let peakRssBytes = process.memoryUsage.rss();
  const start = process.hrtime.bigint();
  const activeCompiler = compiler ?? createCompiler();
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage.rss());
  for (const projectDirectory of projectDirectories) {
    const resolution = await activeCompiler.resolveProject({ projectDirectory });
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage.rss());
    if (resolution.status === "failure") {
      continue;
    }
    await activeCompiler.compile({
      project: resolution.project,
      frontend,
    });
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage.rss());
  }
  return {
    durationNanoseconds: Number(process.hrtime.bigint() - start),
    peakRssBytes,
  };
}

async function compilerColdWorker(id: FrontendId): Promise<WorkerMeasurements> {
  const frontend = await frontendById(id);
  const project = await createTemporaryProject();
  try {
    const projectDirectories = await copyCompilerCorpus(project.projectRoot);
    return {
      frontend: id,
      cacheKey: frontend.cacheKey,
      samples: [await measureCompilerPipeline(frontend, projectDirectories)],
    };
  } finally {
    await project.cleanup();
  }
}

interface LiveWorkerReady {
  readonly kind: "ready";
  readonly frontend: FrontendId;
  readonly cacheKey: string;
}

interface LiveWorkerSample {
  readonly kind: "sample";
  readonly measurement: Measurement;
}

function isLiveWorkerReady(value: unknown): value is LiveWorkerReady {
  return (
    isObject(value) &&
    "kind" in value &&
    value.kind === "ready" &&
    "frontend" in value &&
    (value.frontend === "babel" || value.frontend === "yuku") &&
    "cacheKey" in value &&
    typeof value.cacheKey === "string"
  );
}

function isLiveWorkerSample(value: unknown): value is LiveWorkerSample {
  return (
    isObject(value) &&
    "kind" in value &&
    value.kind === "sample" &&
    "measurement" in value &&
    isMeasurement(value.measurement)
  );
}

function parseLiveWorkerLine(line: unknown): LiveWorkerReady | LiveWorkerSample {
  if (typeof line !== "string") {
    throw new TypeError("Benchmark worker output must be text.");
  }
  const value: unknown = JSON.parse(line);
  if (isLiveWorkerReady(value) || isLiveWorkerSample(value)) {
    return value;
  }
  throw new TypeError("Benchmark worker returned an invalid line.");
}

interface LiveCompilerWorker {
  readonly frontend: FrontendId;
  readonly cacheKey: string;
  measure(changeIndex: number): Promise<Measurement>;
  close(): Promise<void>;
}

async function startCompilerWorker(id: FrontendId): Promise<LiveCompilerWorker> {
  const child = spawnCommand(
    process.execPath,
    ["--conditions=development", import.meta.filename, "--compiler-incremental-worker", id],
    { cwd: process.cwd() },
  );
  const input = child.writable();
  const output = child.iterable()[Symbol.asyncIterator]();
  let ready: LiveWorkerReady | LiveWorkerSample;
  try {
    const readyLine = await output.next();
    ready = parseLiveWorkerLine(readyLine.value);
  } catch (error) {
    input.end();
    await child.catch(() => undefined);
    throw error;
  }
  if (ready.kind !== "ready" || ready.frontend !== id) {
    input.end();
    await child.catch(() => undefined);
    throw new Error(`Benchmark worker ${id} did not become ready.`);
  }
  let closePromise: Promise<void> | undefined;
  return {
    frontend: id,
    cacheKey: ready.cacheKey,
    async measure(changeIndex) {
      input.write(`${changeIndex}\n`);
      const next = await output.next();
      const message = parseLiveWorkerLine(next.value);
      if (message.kind !== "sample") {
        throw new Error(`Benchmark worker ${id} did not return a sample.`);
      }
      return message.measurement;
    },
    close() {
      closePromise ??= new Promise<void>((resolve, reject) => {
        input.end();
        void child.then((result) => {
          if (result.exitCode === 0) {
            resolve();
          } else {
            reject(new Error(`Benchmark worker ${id} exited with ${result.exitCode}.`));
          }
        }, reject);
      });
      return closePromise;
    },
  };
}

function frontendOrder(index: number): readonly FrontendId[] {
  return index % 2 === 0 ? ["babel", "yuku"] : ["yuku", "babel"];
}

async function warmCompilerColdWorkers(): Promise<void> {
  for (let index = 0; index < warmupCount; index += 1) {
    for (const id of frontendOrder(index)) {
      await runSelf(["--compiler-cold-worker", id]);
    }
  }
}

async function compilerColdSamples(): Promise<Readonly<Record<FrontendId, WorkerMeasurements>>> {
  const samples: Record<FrontendId, Measurement[]> = { babel: [], yuku: [] };
  const cacheKeys: Record<FrontendId, string> = { babel: "", yuku: "" };
  for (let index = 0; index < sampleCount; index += 1) {
    for (const id of frontendOrder(index)) {
      const result = await runSelf(["--compiler-cold-worker", id]);
      samples[id].push(...result.samples);
      cacheKeys[id] = result.cacheKey;
    }
  }
  return {
    babel: {
      frontend: "babel",
      cacheKey: cacheKeys.babel,
      samples: samples.babel,
    },
    yuku: {
      frontend: "yuku",
      cacheKey: cacheKeys.yuku,
      samples: samples.yuku,
    },
  };
}

async function compilerIncrementalSamples(): Promise<
  Readonly<Record<FrontendId, WorkerMeasurements>>
> {
  const babel = await startCompilerWorker("babel");
  let yuku: LiveCompilerWorker | undefined;
  const samples: Record<FrontendId, Measurement[]> = { babel: [], yuku: [] };
  try {
    yuku = await startCompilerWorker("yuku");
    const workers = { babel, yuku } as const;
    for (let index = 0; index < warmupCount; index += 1) {
      for (const id of frontendOrder(index)) {
        await workers[id].measure(index);
      }
    }
    for (let index = 0; index < sampleCount; index += 1) {
      for (const id of frontendOrder(index)) {
        samples[id].push(await workers[id].measure(warmupCount + index));
      }
    }
    return {
      babel: {
        frontend: "babel",
        cacheKey: babel.cacheKey,
        samples: samples.babel,
      },
      yuku: {
        frontend: "yuku",
        cacheKey: yuku.cacheKey,
        samples: samples.yuku,
      },
    };
  } finally {
    await Promise.all([babel.close(), yuku?.close()]);
  }
}

function printJsonLine(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function compilerIncrementalWorker(id: FrontendId): Promise<void> {
  const frontend = await frontendById(id);
  const project = await createTemporaryProject();
  try {
    const projectDirectories = await copyCompilerCorpus(project.projectRoot);
    const sourcePath = path.join(
      project.projectRoot,
      "deterministic-cycle-generation",
      "src",
      "alpha.ts",
    );
    const source = await readFile(sourcePath, "utf8");
    const compiler = createCompiler();
    printJsonLine({ kind: "ready", frontend: id, cacheKey: frontend.cacheKey });
    const commands = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
    for await (const command of commands) {
      const changeIndex = Number(command);
      if (!Number.isSafeInteger(changeIndex)) {
        throw new TypeError("Benchmark change index must be an integer.");
      }
      await writeFile(sourcePath, `${source}\n// benchmark change ${changeIndex}\n`);
      printJsonLine({
        kind: "sample",
        measurement: await measureCompilerPipeline(frontend, projectDirectories, compiler),
      });
    }
  } finally {
    await project.cleanup();
  }
}

async function warmAdapterColdWorkers(): Promise<void> {
  for (let index = 0; index < warmupCount; index += 1) {
    await runSelf(["--adapter-cold-worker", "babel"]);
    await runSelf(["--adapter-cold-worker", "yuku"]);
  }
}

async function adapterColdSamples(): Promise<Readonly<Record<FrontendId, WorkerMeasurements>>> {
  const samples: Record<FrontendId, Measurement[]> = { babel: [], yuku: [] };
  let babelCacheKey = "";
  let yukuCacheKey = "";
  for (let index = 0; index < sampleCount; index += 1) {
    const babel = await runSelf(["--adapter-cold-worker", "babel"]);
    const yuku = await runSelf(["--adapter-cold-worker", "yuku"]);
    samples.babel.push(...babel.samples);
    samples.yuku.push(...yuku.samples);
    babelCacheKey = babel.cacheKey;
    yukuCacheKey = yuku.cacheKey;
  }
  return {
    babel: { frontend: "babel", cacheKey: babelCacheKey, samples: samples.babel },
    yuku: { frontend: "yuku", cacheKey: yukuCacheKey, samples: samples.yuku },
  };
}

function summarize(
  cold: WorkerMeasurements,
  incremental: WorkerMeasurements,
): FrontendMeasurements {
  const coldDurations = cold.samples.map((sample) => sample.durationNanoseconds);
  const incrementalDurations = incremental.samples.map((sample) => sample.durationNanoseconds);
  return {
    frontend: cold.frontend,
    cacheKey: cold.cacheKey,
    cold: cold.samples,
    incremental: incremental.samples,
    coldP50Nanoseconds: percentile(coldDurations, 0.5),
    coldP95Nanoseconds: percentile(coldDurations, 0.95),
    incrementalP50Nanoseconds: percentile(incrementalDurations, 0.5),
    incrementalP95Nanoseconds: percentile(incrementalDurations, 0.95),
    peakRssBytes: Math.max(
      ...cold.samples.map((sample) => sample.peakRssBytes),
      ...incremental.samples.map((sample) => sample.peakRssBytes),
    ),
  };
}

function withinFivePercent(left: number, right: number): boolean {
  return Math.max(left, right) <= Math.min(left, right) * 1.05;
}

function selectDefault(babel: FrontendMeasurements, yuku: FrontendMeasurements): FrontendId {
  if (!withinFivePercent(babel.incrementalP95Nanoseconds, yuku.incrementalP95Nanoseconds)) {
    return babel.incrementalP95Nanoseconds < yuku.incrementalP95Nanoseconds ? "babel" : "yuku";
  }
  if (!withinFivePercent(babel.peakRssBytes, yuku.peakRssBytes)) {
    return babel.peakRssBytes < yuku.peakRssBytes ? "babel" : "yuku";
  }
  if (!withinFivePercent(babel.coldP95Nanoseconds, yuku.coldP95Nanoseconds)) {
    return babel.coldP95Nanoseconds < yuku.coldP95Nanoseconds ? "babel" : "yuku";
  }
  return "babel";
}

async function publishBenchmark(value: unknown): Promise<void> {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  process.stdout.write(serialized);
  const outputPath = process.env.REFORCE_BENCHMARK_OUTPUT;
  if (outputPath === undefined) {
    return;
  }
  const absolutePath = path.resolve(outputPath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, serialized, "utf8");
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function benchmarkInputs(): Promise<{
  readonly lockfileSha256: string;
  readonly fixtureSha256: string;
}> {
  const hash = createHash("sha256");
  hash.update(await readFile(path.join(repositoryRoot, "bun.lock")));
  const lockfileSha256 = hash.digest("hex");
  const fixtureHash = createHash("sha256");
  for (const entry of await readFixtureTree(fixtureDirectory)) {
    fixtureHash.update(entry.path, "utf8");
    fixtureHash.update("\0", "utf8");
    fixtureHash.update(entry.bytes);
    fixtureHash.update("\0", "utf8");
  }
  return { lockfileSha256, fixtureSha256: fixtureHash.digest("hex") };
}

async function runnerMetadata(): Promise<Record<string, unknown>> {
  const bunVersion = typeof Bun === "undefined" ? null : Bun.version;
  const installedBun =
    bunVersion === null ? await runCommand("bun", ["--version"], { cwd: repositoryRoot }) : null;
  return {
    platform: process.platform,
    arch: process.arch,
    cpu: os.cpus()[0]?.model ?? "unknown",
    runtime: bunVersion === null ? "node" : "bun",
    node: process.version,
    bun:
      bunVersion ??
      (installedBun?.exitCode === 0 && typeof installedBun.stdout === "string"
        ? installedBun.stdout.trim()
        : null),
  };
}

async function compilerCoordinator(): Promise<void> {
  await assertFrontendConformance();
  await warmCompilerColdWorkers();
  const cold = await compilerColdSamples();
  const incremental = await compilerIncrementalSamples();
  const babel = summarize(cold.babel, incremental.babel);
  const yuku = summarize(cold.yuku, incremental.yuku);
  await publishBenchmark({
    schemaVersion: 1,
    benchmark: "compiler-pipeline",
    runner: await runnerMetadata(),
    inputs: await benchmarkInputs(),
    protocol: {
      conformance: "exact-source-ir-span-diagnostic",
      warmupCount,
      sampleCount,
      percentile: "nearest-rank",
      pipeline: "createCompiler.resolveProject.compile",
      corpus: "every package-local Compiler fixture with a direct tsconfig",
      coldTimedOperation: "new Compiler resolveProject+compile full corpus",
      incrementalTimedOperation: "same Compiler resolveProject+compile full corpus",
      rssSampling: "process-rss-at-pipeline-stage-boundaries",
      coldIsolation: "new-process-per-sample",
      incrementalIsolation: "one-process-per-frontend",
      frontendOrder: "alternating-per-iteration",
    },
    measurements: [babel, yuku],
    selected: selectDefault(babel, yuku),
  });
}

async function adapterCoordinator(): Promise<void> {
  await warmAdapterColdWorkers();
  const cold = await adapterColdSamples();
  const [babelIncremental, yukuIncremental] = await Promise.all([
    runSelf(["--adapter-incremental-worker", "babel"]),
    runSelf(["--adapter-incremental-worker", "yuku"]),
  ]);
  const babel = summarize(cold.babel, babelIncremental);
  const yuku = summarize(cold.yuku, yukuIncremental);
  await publishBenchmark({
    schemaVersion: 1,
    benchmark: "adapter-diagnostic",
    runner: await runnerMetadata(),
    protocol: {
      warmupCount,
      sampleCount,
      percentile: "nearest-rank",
      coldIsolation: "new-process",
    },
    measurements: [babel, yuku],
    selected: selectDefault(babel, yuku),
  });
}

const mode = process.argv[2];
const frontend = process.argv[3];
const validFrontend = frontend === "babel" || frontend === "yuku";
if (mode === "--compiler-cold-worker" && validFrontend) {
  printJson(await compilerColdWorker(frontend));
} else if (mode === "--compiler-incremental-worker" && validFrontend) {
  await compilerIncrementalWorker(frontend);
} else if (mode === "--adapter-cold-worker" && validFrontend) {
  printJson(await adapterColdWorker(frontend));
} else if (mode === "--adapter-incremental-worker" && validFrontend) {
  printJson(await adapterIncrementalWorker(frontend));
} else if (mode === "--adapter") {
  await adapterCoordinator();
} else if (mode === undefined) {
  await compilerCoordinator();
} else {
  throw new Error(`Unknown benchmark mode: ${mode ?? "none"}.`);
}
