import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeProjectTree } from "@reforce/tooling-testing";
import { afterEach, expect, test } from "vitest";
import { createCompiler } from "@/index";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        force: true,
        recursive: true,
      }),
    ),
  );
});

function applicationTsconfig(files: readonly string[]): string {
  return `${JSON.stringify({
    compilerOptions: {
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
    },
    files: [...files, ".reforce/generated/qualifiers.d.ts"],
  })}\n`;
}

async function createTemporaryDirectory(parent: string, prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(await realpath(parent), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function localhostAdminShare(localPath: string): string {
  const root = path.win32.parse(localPath).root;
  const driveLetter = root.at(0);
  if (driveLetter === undefined || !/^[a-z]:\\$/iu.test(root)) {
    throw new Error(`A drive-local path is required to construct a UNC boundary: ${localPath}`);
  }
  const suffix = localPath.slice(root.length).replace(/^\\+/u, "");
  return `\\\\localhost\\${driveLetter}$\\${suffix}`;
}

async function createDirectoriesOnDistinctVolumes(): Promise<readonly [string, string]> {
  const candidates = [
    process.cwd(),
    tmpdir(),
    process.env.RUNNER_TEMP,
    process.env.TEMP,
    process.env.TMP,
    process.env.LOCALAPPDATA,
    process.env.USERPROFILE,
    process.env.GITHUB_WORKSPACE,
  ];
  const directories = new Map<string, string>();
  const failures: string[] = [];

  for (const candidate of candidates) {
    if (candidate === undefined || !path.isAbsolute(candidate)) {
      continue;
    }
    try {
      const canonicalParent = await realpath(candidate);
      const volume = path.parse(canonicalParent).root.toUpperCase();
      if (directories.has(volume)) {
        continue;
      }
      const directory = await createTemporaryDirectory(canonicalParent, ".reforce-cross-volume-");
      directories.set(volume, directory);
    } catch (error) {
      failures.push(`${candidate}: ${String(error)}`);
    }
  }

  const [first, second] = directories.values();
  if (first === undefined || second === undefined) {
    throw new Error(
      `Two writable Windows volumes are required; found ${[...directories.keys()].join(", ") || "none"}. ${failures.join(" | ")}`,
    );
  }
  return [first, second];
}

test.skipIf(process.platform !== "win32")(
  "resolves and compiles an application selected through a real UNC boundary",
  async () => {
    const localProject = await createTemporaryDirectory(process.cwd(), ".reforce-unc-");
    await writeProjectTree(localProject, {
      src: {
        "application.ts": "export class ApplicationService {}\n",
      },
      "tsconfig.json": applicationTsconfig(["src/application.ts"]),
    });
    const uncProject = localhostAdminShare(localProject);
    await access(uncProject);
    const compiler = createCompiler();

    const resolution = await compiler.resolveProject({ projectDirectory: uncProject });
    if (resolution.status === "failure") {
      throw new Error(JSON.stringify(resolution.diagnostics));
    }
    const compilation = await compiler.compile({ project: resolution.project });

    expect(compilation.status).toBe("success");
    if (compilation.status === "success") {
      expect(compilation.files.map((file) => file.path)).toEqual([
        "beans.ts",
        "qualifiers.d.ts",
        "manifest.json",
        "bootstrap.ts",
        "routes.json",
        "routes.ts",
        "weaving.json",
      ]);
    }
  },
);

test.skipIf(process.platform !== "win32")(
  "rejects an application source that resides on another real Windows volume",
  async () => {
    const [applicationRoot, externalRoot] = await createDirectoriesOnDistinctVolumes();
    const externalSource = path.join(externalRoot, "external.ts");
    await writeProjectTree(applicationRoot, {
      src: {
        "application.ts": "export class ApplicationService {}\n",
      },
      "tsconfig.json": applicationTsconfig(["src/application.ts", externalSource]),
    });
    await writeProjectTree(externalRoot, {
      "external.ts": "export interface ExternalContract {}\n",
    });
    const compiler = createCompiler();

    const resolution = await compiler.resolveProject({ projectDirectory: applicationRoot });

    expect(resolution.status).toBe("failure");
    if (resolution.status === "failure") {
      expect(resolution.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
        "SOURCE_OUTSIDE_PROJECT_ROOT",
      ]);
      expect(resolution.watchInputs.fileDependencies).toContain(externalSource);
    }
  },
);
