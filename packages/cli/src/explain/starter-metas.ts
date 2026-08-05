import { readFile, realpath } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { toPortablePath } from "@reforce/primitives";
import { isObject } from "radashi";
import { pathExists } from "@/project/fs-error";

// explain 只消费生成物与磁盘上的静态事实（Issue #148）：manifest 记录了最终胜出者，让位与
// 引入链要从已安装 starter 的 meta 和 node_modules 布局再推导。发现闭包从 manifest 里出现过的
// starter 包出发、沿 meta 的 starterDeps 递归——与链接器的注册闭包同构，但拿不到应用源码里的
// 注册声明，因此「被本地 provider 完全遮蔽、一个 bean 都没进 manifest 的 starter」在这里不可见；
// 该盲点在命令输出与交付说明中明示，补齐需要 manifest 记录注册表（编译器侧，超出本 issue）。
//
// 引入链的载体是 node_modules 布局而非 pnpm-lock.yaml：布局是链接器实际解析到的事实（哪个目录下装了
// 哪份拷贝），pnpm-lock.yaml 只是安装计划；「分别由谁引入」按解析起点回答——从应用根解析到的拷贝记
// 「应用直接可达」，从某个 starter 包根解析到的嵌套拷贝记「由该 starter 引入」。

export interface InstalledStarterBean {
  readonly id: string;
  readonly provides: readonly string[];
  readonly defaultBean: boolean;
}

export interface InstalledStarter {
  readonly packageName: string;
  readonly version: string;
  /** 应用根相对的可移植路径（如 node_modules/@acme/starter-redis），用于呈现。 */
  readonly location: string;
  /** 符号链接解析后的物理路径，两份拷贝是否同一物理文件以此为准（ADR 0004 决策 10）。 */
  readonly realRootPath: string;
  /** undefined 表示从应用根解析可达；否则为引入它的 starter 的 `包名@版本`。 */
  readonly introducedBy: string | undefined;
  readonly beans: readonly InstalledStarterBean[];
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

// meta 在这里是展示素材而不是链接输入：形状不合规不报错（生产/消费两侧各有硬校验），
// 读得出多少展示多少。
function readBeans(value: unknown): readonly InstalledStarterBean[] {
  if (!isObject(value)) {
    return [];
  }
  const beans = Reflect.get(value, "beans");
  if (!Array.isArray(beans)) {
    return [];
  }
  return beans.flatMap((bean): InstalledStarterBean[] => {
    if (!isObject(bean)) {
      return [];
    }
    const id = Reflect.get(bean, "id");
    if (typeof id !== "string") {
      return [];
    }
    return [
      {
        id,
        provides: stringArray(Reflect.get(bean, "provides")),
        defaultBean: Reflect.get(bean, "defaultBean") === true,
      },
    ];
  });
}

async function locatePackageRoot(
  fromDirectory: string,
  packageName: string,
): Promise<string | undefined> {
  const segments = packageName.split("/");
  for (let directory = fromDirectory; ; directory = dirname(directory)) {
    const candidate = join(directory, "node_modules", ...segments);
    if (await pathExists(join(candidate, "package.json"))) {
      return candidate;
    }
    if (dirname(directory) === directory) {
      return undefined;
    }
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

interface DiscoveryRequest {
  readonly packageName: string;
  readonly fromDirectory: string;
  readonly introducedBy: string | undefined;
}

interface ResolvedStarter {
  readonly starter: InstalledStarter;
  readonly dependencies: readonly DiscoveryRequest[];
}

async function resolveStarter(
  projectRoot: string,
  request: DiscoveryRequest,
): Promise<ResolvedStarter | undefined> {
  const rootPath = await locatePackageRoot(request.fromDirectory, request.packageName);
  if (rootPath === undefined) {
    return undefined;
  }
  const realRootPath = await realpath(rootPath);
  const packageJson = await readJson(join(rootPath, "package.json"));
  if (!isObject(packageJson)) {
    return undefined;
  }
  const version = Reflect.get(packageJson, "version");
  const exports = Reflect.get(packageJson, "exports");
  const metaTarget = isObject(exports) ? Reflect.get(exports, "./reforce-meta") : undefined;
  if (typeof version !== "string" || typeof metaTarget !== "string") {
    return undefined;
  }
  const meta = await readJson(join(rootPath, metaTarget));
  return {
    starter: {
      packageName: request.packageName,
      version,
      location: toPortablePath(relative(projectRoot, rootPath)),
      realRootPath,
      introducedBy: request.introducedBy,
      beans: readBeans(meta),
    },
    dependencies: stringArray(isObject(meta) ? Reflect.get(meta, "starterDeps") : []).map(
      (dependency) => ({
        packageName: dependency,
        // 从引入者的物理包根解析：嵌套安装的拷贝只有从这里才可达，这正是引入链的定义。
        fromDirectory: realRootPath,
        introducedBy: `${request.packageName}@${version}`,
      }),
    ),
  };
}

export async function discoverInstalledStarters(
  projectRoot: string,
  seedPackageNames: readonly string[],
): Promise<readonly InstalledStarter[]> {
  const discovered: InstalledStarter[] = [];
  const visitedRoots = new Set<string>();
  // 队列按发现顺序处理（种子已排序），同一物理拷贝首个发现者的解析起点即它的引入记录。
  const queue: DiscoveryRequest[] = [...seedPackageNames]
    .sort()
    .map((packageName) => ({ packageName, fromDirectory: projectRoot, introducedBy: undefined }));
  while (true) {
    const request = queue.shift();
    if (request === undefined) {
      return discovered;
    }
    const resolved = await resolveStarter(projectRoot, request);
    if (resolved === undefined || visitedRoots.has(resolved.starter.realRootPath)) {
      continue;
    }
    visitedRoots.add(resolved.starter.realRootPath);
    discovered.push(resolved.starter);
    queue.push(...resolved.dependencies);
  }
}

// 同名包出现多份物理拷贝（决策 10 的真版本撕裂）。key 是包名，值按发现顺序列出各拷贝。
export function multipleCopyGroups(
  starters: readonly InstalledStarter[],
): ReadonlyMap<string, readonly InstalledStarter[]> {
  const byName = new Map<string, InstalledStarter[]>();
  for (const starter of starters) {
    const group = byName.get(starter.packageName) ?? [];
    byName.set(starter.packageName, group);
    group.push(starter);
  }
  return new Map([...byName].filter(([, group]) => group.length > 1));
}
