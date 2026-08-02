import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isObject } from "radashi";
import {
  aggregateWorstCase,
  type FrontendId,
  type FrontendSummary,
  selectDefaultFrontend,
} from "#tooling/frontend-selection";

type RunnerPlatform = "darwin" | "linux" | "win32";

interface PlatformBenchmark {
  readonly platform: RunnerPlatform;
  readonly arch: string;
  readonly cpu: string;
  readonly node: string;
  readonly bun: string;
  readonly lockfileSha256: string;
  readonly fixtureSha256: string;
  readonly measurements: Readonly<Record<FrontendId, FrontendSummary>>;
}

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

function fail(message: string): never {
  throw new TypeError(message);
}

function requiredObject(value: unknown, pathLabel: string): object {
  if (!isObject(value)) {
    return fail(`${pathLabel} must be an object.`);
  }
  return value;
}

function requiredArray(value: unknown, pathLabel: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    return fail(`${pathLabel} must be an array.`);
  }
  return value;
}

function requiredString(value: unknown, pathLabel: string): string {
  if (typeof value !== "string" || value.length === 0) {
    return fail(`${pathLabel} must be a non-empty string.`);
  }
  return value;
}

function requiredNumber(value: unknown, pathLabel: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fail(`${pathLabel} must be a non-negative finite number.`);
  }
  return value;
}

function validateRawSamples(value: unknown, pathLabel: string): void {
  const samples = requiredArray(value, pathLabel);
  if (samples.length !== 30) {
    fail(`${pathLabel} must contain exactly 30 measured samples.`);
  }
  for (const [index, sampleValue] of samples.entries()) {
    const sample = requiredObject(sampleValue, `${pathLabel}[${index}]`);
    requiredNumber(
      Reflect.get(sample, "durationNanoseconds"),
      `${pathLabel}[${index}].durationNanoseconds`,
    );
    requiredNumber(Reflect.get(sample, "peakRssBytes"), `${pathLabel}[${index}].peakRssBytes`);
  }
}

function frontendSummary(value: unknown, pathLabel: string): FrontendSummary {
  const measurement = requiredObject(value, pathLabel);
  const frontendValue = Reflect.get(measurement, "frontend");
  if (frontendValue !== "babel" && frontendValue !== "yuku") {
    return fail(`${pathLabel}.frontend is unknown.`);
  }
  requiredString(Reflect.get(measurement, "cacheKey"), `${pathLabel}.cacheKey`);
  validateRawSamples(Reflect.get(measurement, "cold"), `${pathLabel}.cold`);
  validateRawSamples(Reflect.get(measurement, "incremental"), `${pathLabel}.incremental`);
  return {
    frontend: frontendValue,
    coldP95Nanoseconds: requiredNumber(
      Reflect.get(measurement, "coldP95Nanoseconds"),
      `${pathLabel}.coldP95Nanoseconds`,
    ),
    incrementalP95Nanoseconds: requiredNumber(
      Reflect.get(measurement, "incrementalP95Nanoseconds"),
      `${pathLabel}.incrementalP95Nanoseconds`,
    ),
    peakRssBytes: requiredNumber(
      Reflect.get(measurement, "peakRssBytes"),
      `${pathLabel}.peakRssBytes`,
    ),
  };
}

function runnerPlatform(value: unknown, pathLabel: string): RunnerPlatform {
  if (value === "darwin" || value === "linux" || value === "win32") {
    return value;
  }
  return fail(`${pathLabel} is not a supported runner platform.`);
}

function measurementRecord(
  measurements: readonly FrontendSummary[],
  pathLabel: string,
): Readonly<Record<FrontendId, FrontendSummary>> {
  const babel = measurements.find((measurement) => measurement.frontend === "babel");
  const yuku = measurements.find((measurement) => measurement.frontend === "yuku");
  if (measurements.length !== 2 || babel === undefined || yuku === undefined) {
    return fail(`${pathLabel} must contain one Babel and one Yuku measurement.`);
  }
  return { babel, yuku };
}

async function loadBenchmark(filename: string): Promise<PlatformBenchmark> {
  const value: unknown = JSON.parse(await readFile(filename, "utf8"));
  const result = requiredObject(value, filename);
  if (
    Reflect.get(result, "schemaVersion") !== 1 ||
    Reflect.get(result, "benchmark") !== "compiler-pipeline"
  ) {
    return fail(`${filename} is not a compiler pipeline benchmark artifact.`);
  }
  const protocol = requiredObject(Reflect.get(result, "protocol"), `${filename}.protocol`);
  if (
    Reflect.get(protocol, "warmupCount") !== 10 ||
    Reflect.get(protocol, "sampleCount") !== 30 ||
    Reflect.get(protocol, "percentile") !== "nearest-rank"
  ) {
    return fail(`${filename} used a different benchmark protocol.`);
  }
  const runner = requiredObject(Reflect.get(result, "runner"), `${filename}.runner`);
  const runtime = requiredString(Reflect.get(runner, "runtime"), `${filename}.runner.runtime`);
  if (runtime !== "node") {
    return fail(`${filename} was not measured by Node.`);
  }
  const inputs = requiredObject(Reflect.get(result, "inputs"), `${filename}.inputs`);
  const measurements = requiredArray(
    Reflect.get(result, "measurements"),
    `${filename}.measurements`,
  ).map((measurement, index) => frontendSummary(measurement, `${filename}.measurements[${index}]`));
  return {
    platform: runnerPlatform(Reflect.get(runner, "platform"), `${filename}.runner.platform`),
    arch: requiredString(Reflect.get(runner, "arch"), `${filename}.runner.arch`),
    cpu: requiredString(Reflect.get(runner, "cpu"), `${filename}.runner.cpu`),
    node: requiredString(Reflect.get(runner, "node"), `${filename}.runner.node`),
    bun: requiredString(Reflect.get(runner, "bun"), `${filename}.runner.bun`),
    lockfileSha256: requiredString(
      Reflect.get(inputs, "lockfileSha256"),
      `${filename}.inputs.lockfileSha256`,
    ),
    fixtureSha256: requiredString(
      Reflect.get(inputs, "fixtureSha256"),
      `${filename}.inputs.fixtureSha256`,
    ),
    measurements: measurementRecord(measurements, `${filename}.measurements`),
  };
}

async function configuredCliDefault(): Promise<FrontendId> {
  const value: unknown = JSON.parse(
    await readFile(path.join(repositoryRoot, "packages", "cli", "package.json"), "utf8"),
  );
  const manifest = requiredObject(value, "packages/cli/package.json");
  const dependencies = requiredObject(
    Reflect.get(manifest, "dependencies"),
    "packages/cli/package.json dependencies",
  );
  const hasBabel = Reflect.has(dependencies, "@reforce/compiler-babel");
  const hasYuku = Reflect.has(dependencies, "@reforce/compiler-yuku");
  if (hasBabel === hasYuku) {
    return fail("CLI must depend on exactly one benchmarked frontend adapter.");
  }
  return hasBabel ? "babel" : "yuku";
}

async function publish(value: unknown): Promise<void> {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  process.stdout.write(serialized);
  const outputPath = process.env.REFORCE_FRONTEND_SELECTION_OUTPUT;
  if (outputPath === undefined) {
    return;
  }
  const absolutePath = path.resolve(outputPath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, serialized, "utf8");
}

const filenames = process.argv.slice(2);
if (filenames.length !== 3) {
  throw new Error("Pass exactly the Linux, macOS, and Windows benchmark artifact paths.");
}
const results = await Promise.all(filenames.map(loadBenchmark));
const platforms = new Set(results.map((result) => result.platform));
if (
  platforms.size !== 3 ||
  !(["darwin", "linux", "win32"] as const).every((name) => platforms.has(name))
) {
  throw new Error("Benchmark selection requires one Linux, one macOS, and one Windows artifact.");
}
const inputIdentities = new Set(
  results.map((result) => `${result.lockfileSha256}:${result.fixtureSha256}`),
);
if (inputIdentities.size !== 1) {
  throw new Error("Benchmark artifacts did not use the same lockfile and fixture bytes.");
}
const babel = aggregateWorstCase(
  "babel",
  results.map((result) => result.measurements.babel),
);
const yuku = aggregateWorstCase(
  "yuku",
  results.map((result) => result.measurements.yuku),
);
const selected = selectDefaultFrontend(babel, yuku);
const cliDefault = await configuredCliDefault();
await publish({
  schemaVersion: 1,
  benchmark: "global-frontend-selection",
  inputs: {
    lockfileSha256: results[0]?.lockfileSha256,
    fixtureSha256: results[0]?.fixtureSha256,
  },
  runners: results.map(({ platform, arch, cpu, node, bun }) => ({
    platform,
    arch,
    cpu,
    node,
    bun,
  })),
  measurements: [babel, yuku],
  selected,
  cliDefault,
});
if (selected !== cliDefault) {
  throw new Error(`Benchmark selected ${selected}, but CLI depends on ${cliDefault}.`);
}
