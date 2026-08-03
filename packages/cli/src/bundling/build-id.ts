import { createHash } from "node:crypto";
import { compareUtf16CodeUnits } from "@reforce/primitives";

export type DevBuildAssetRole = "entry" | "chunk" | "source-map" | "hot-update";

export interface DevBuildAsset {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly role: DevBuildAssetRole;
}

export interface CreateDevBuildIdInput {
  readonly statsHash?: string;
  readonly assets: readonly DevBuildAsset[];
}

function validateAssetPath(path: string): void {
  const segments = path.split("/");
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Development asset path is not relative POSIX: ${path}`);
  }
}

export function createDevBuildId(input: CreateDevBuildIdInput): string {
  if (input.statsHash?.trim()) {
    return `rspack:${input.statsHash}`;
  }
  const runtimeAssets = input.assets
    .filter((asset) => asset.role === "entry" || asset.role === "chunk")
    .toSorted((left, right) => compareUtf16CodeUnits(left.path, right.path));
  if (!runtimeAssets.some((asset) => asset.role === "entry" && asset.path === "main.mjs")) {
    throw new Error("Development assets do not contain main.mjs.");
  }
  const seen = new Set<string>();
  const hash = createHash("sha256");
  for (const asset of runtimeAssets) {
    validateAssetPath(asset.path);
    if (seen.has(asset.path)) {
      throw new Error(`Development asset path is duplicated: ${asset.path}`);
    }
    seen.add(asset.path);
    hash.update(asset.path, "utf8");
    hash.update("\0", "utf8");
    hash.update(String(asset.bytes.byteLength), "utf8");
    hash.update("\0", "utf8");
    hash.update(asset.bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}
