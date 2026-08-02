import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { execa } from "execa";

const runtimeProbe =
  'JSON.stringify({release:process.release.name,bun:Reflect.get(process.versions,"bun")})';

interface RuntimeIdentity {
  readonly bun?: string;
  readonly release: string;
}

function parseRuntimeIdentity(output: unknown): RuntimeIdentity | undefined {
  if (typeof output !== "string") {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(output);
    if (typeof value !== "object" || value === null) {
      return undefined;
    }
    const release = Reflect.get(value, "release");
    const bun = Reflect.get(value, "bun");
    if (typeof release !== "string" || (bun !== undefined && typeof bun !== "string")) {
      return undefined;
    }
    return { release, ...(bun === undefined ? {} : { bun }) };
  } catch {
    return undefined;
  }
}

function executableNames(): readonly string[] {
  if (process.platform === "win32") {
    return ["node.exe"];
  }
  return ["node"];
}

function executableCandidates(environment: NodeJS.ProcessEnv): readonly string[] {
  const candidates: string[] = [];
  for (const configured of [environment.NODE, environment.npm_node_execpath]) {
    if (configured !== undefined && isAbsolute(configured)) {
      candidates.push(configured);
    }
  }
  for (const directory of environment.PATH?.split(delimiter) ?? []) {
    if (directory.length === 0) {
      continue;
    }
    for (const name of executableNames()) {
      candidates.push(join(directory, name));
    }
  }
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const identity = process.platform === "win32" ? candidate.toLowerCase() : candidate;
    if (seen.has(identity)) {
      return false;
    }
    seen.add(identity);
    return true;
  });
}

async function isNodeExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    const [version, identity] = await Promise.all([
      execa(candidate, ["--version"], {
        reject: false,
        shell: false,
        timeout: 10_000,
      }),
      execa(candidate, ["-p", runtimeProbe], {
        reject: false,
        shell: false,
        timeout: 10_000,
      }),
    ]);
    const runtime = parseRuntimeIdentity(identity.stdout);
    return (
      version.exitCode === 0 &&
      typeof version.stdout === "string" &&
      /^v\d+\./u.test(version.stdout.trim()) &&
      identity.exitCode === 0 &&
      runtime?.release === "node" &&
      runtime.bun === undefined
    );
  } catch {
    return false;
  }
}

let resolution: Promise<string> | undefined;

async function findNodeExecutable(): Promise<string> {
  for (const candidate of executableCandidates(process.env)) {
    if (await isNodeExecutable(candidate)) {
      return await realpath(candidate);
    }
  }
  throw new Error("Unable to locate an actual Node.js executable on PATH.");
}

export function resolveNodeExecutable(): Promise<string> {
  resolution ??= findNodeExecutable();
  return resolution;
}
