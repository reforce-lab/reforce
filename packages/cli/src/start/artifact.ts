import { lstat, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { isPathStrictlyContained } from "@reforce/primitives";
import { ReforceCliError } from "@/errors";
import { findIncompleteDistTransaction } from "@/project/directory-transaction";

export class ArtifactInvalidError extends ReforceCliError<"ARTIFACT_INVALID"> {
  readonly code = "ARTIFACT_INVALID" as const;

  constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message, options);
  }
}

// 严格变体：projectRoot 自身不可能是生产入口文件，等值一律拒绝。
function assertContained(root: string, target: string): void {
  if (isPathStrictlyContained(root, target)) {
    return;
  }
  throw new Error(`Production entry resolves outside projectRoot: ${target}`);
}

async function assertNoIncompleteDistTransaction(projectRoot: string): Promise<void> {
  const incomplete = await findIncompleteDistTransaction(projectRoot);
  if (incomplete === undefined) {
    return;
  }
  // entryNames 已排序（见 IncompleteDistTransaction），逐条列出让文案带上全部现场且不随平台
  // readdir 顺序漂移（Issue #314）。
  const entries = incomplete.entryNames.join(", ");
  if (incomplete.reason === "journal") {
    throw new ArtifactInvalidError(
      `Production artifact has an incomplete dist transaction (${entries}); run reforce build to recover it.`,
    );
  }
  throw new ArtifactInvalidError(
    `Production artifact has incomplete transaction output: ${entries}`,
  );
}

async function assertOrdinaryArtifactTree(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new ArtifactInvalidError(
        `Production artifact cannot contain a symbolic link: ${entryPath}`,
      );
    }
    if (entry.isDirectory()) {
      await assertOrdinaryArtifactTree(entryPath);
      continue;
    }
    if (!entry.isFile()) {
      throw new ArtifactInvalidError(
        `Production artifact must contain only ordinary files: ${entryPath}`,
      );
    }
  }
}

export async function resolveProductionEntry(projectRoot: string): Promise<string> {
  await assertNoIncompleteDistTransaction(projectRoot);
  const distRoot = join(projectRoot, "dist");
  try {
    const distMetadata = await lstat(distRoot);
    // lstat 不跟随链接，符号链接的 isDirectory() 恒为 false，所以 symlink 必须先判：放在后面
    // 只会让链接到目录的 dist 拿到「不是目录」这句与事实不符的文案（Issue #103）。
    if (distMetadata.isSymbolicLink()) {
      throw new ArtifactInvalidError(`Production artifact cannot be a symbolic link: ${distRoot}`);
    }
    if (!distMetadata.isDirectory()) {
      throw new ArtifactInvalidError(`Production artifact is not a directory: ${distRoot}`);
    }
    await assertOrdinaryArtifactTree(distRoot);
  } catch (cause) {
    if (cause instanceof ArtifactInvalidError) {
      throw cause;
    }
    throw new ArtifactInvalidError(`Production artifact is unavailable: ${distRoot}`, { cause });
  }
  const requestedEntry = join(projectRoot, "dist", "main.mjs");
  let entryPath: string;
  try {
    entryPath = await realpath(requestedEntry);
  } catch (cause) {
    throw new ArtifactInvalidError(`Production artifact is unavailable: ${requestedEntry}`, {
      cause,
    });
  }
  assertContained(projectRoot, entryPath);
  const entryMetadata = await lstat(entryPath);
  if (!entryMetadata.isFile()) {
    throw new ArtifactInvalidError(`Production entry is not an ordinary file: ${requestedEntry}`);
  }
  return entryPath;
}
