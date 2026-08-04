import * as nodeFileSystem from "node:fs";
import path from "node:path";

// 外部文件的包归属：向上找最近的 package.json，取 name/version/包根。跨包符号坐标（ADR 0004
// 决策 7，#120）以包根为锚——同名包装了两份物理拷贝时包根不同，身份自然分开（决策 10 的不合并）。
// 目录到归属的映射按目录缓存：同一个包内的文件共享一次向上查找。

export interface PackageLocation {
  readonly packageName: string;
  readonly version: string;
  readonly rootPath: string;
}

export type PackageLocator = (physicalPath: string) => PackageLocation | undefined;

function readPackageManifest(directory: string): PackageLocation | undefined {
  const manifestPath = path.join(directory, "package.json");
  let bytes: string;
  try {
    bytes = nodeFileSystem.readFileSync(manifestPath, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const name = Reflect.get(parsed, "name");
  if (typeof name !== "string" || name.length === 0) {
    return undefined;
  }
  const version = Reflect.get(parsed, "version");
  return {
    packageName: name,
    version: typeof version === "string" && version.length > 0 ? version : "0.0.0",
    rootPath: directory,
  };
}

export function createPackageLocator(): PackageLocator {
  const byDirectory = new Map<string, PackageLocation | undefined>();

  function locateDirectory(directory: string): PackageLocation | undefined {
    const cached = byDirectory.get(directory);
    if (cached !== undefined || byDirectory.has(directory)) {
      return cached;
    }
    const manifest = readPackageManifest(directory);
    const parent = path.dirname(directory);
    const location = manifest ?? (parent === directory ? undefined : locateDirectory(parent));
    byDirectory.set(directory, location);
    return location;
  }

  return (physicalPath) => locateDirectory(path.dirname(physicalPath));
}
