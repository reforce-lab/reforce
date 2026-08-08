import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";
import { type ProjectSpec, renderPackageJson } from "@/project/package-json";
import { templateLayersFor } from "@/project/template-layers";
import { inspectTargetDirectory } from "@/target-directory";
import { TEMPLATES_ROOT } from "@/templates-root";

// 模板文件名 → 落盘文件名。两条都是被工具链逼出来的，不是风格选择：
//
// - `gitignore`：npm pack 会把 `.gitignore` 整个吞掉（本机实测：同一个 tarball 里
//   `.env.example`、`.editorconfig`、`.gitattributes` 都原样保留，只有 `.gitignore` 和
//   `.npmrc` 消失）。create-next-app 用同样的写法，create-vue 用 `_` 前缀。
// - `biome.jsonc.template`：Biome 的配置发现早于 files.includes 过滤，模板目录里叫
//   biome.jsonc 的文件会被本包自己的 check 当成"嵌套 root 配置"直接报错，忽略规则拦不住。
//
// 别把这张表扩大到不需要改名的文件——模板目录里的名字和生成结果对不上是有成本的。
const TEMPLATE_FILE_RENAMES: Readonly<Record<string, string>> = {
  gitignore: ".gitignore",
  "biome.jsonc.template": "biome.jsonc",
};

function targetFileName(templateFileName: string): string {
  return TEMPLATE_FILE_RENAMES[templateFileName] ?? templateFileName;
}

async function copyLayer(layerRoot: string, targetRoot: string, written: string[]): Promise<void> {
  const entries = await readdir(layerRoot, { withFileTypes: true, recursive: true });
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const sourcePath = join(entry.parentPath, entry.name);
    const relativeDirectory = relative(layerRoot, entry.parentPath);
    const targetPath = join(targetRoot, relativeDirectory, targetFileName(entry.name));
    await mkdir(join(targetRoot, relativeDirectory), { recursive: true });
    await writeFile(targetPath, await readFile(sourcePath));
    written.push(relative(targetRoot, targetPath).split(sep).join(posix.sep));
  }
}

export interface ScaffoldResult {
  // 相对目标目录的 posix 路径，已排序：IT 直接拿它断言文件树，也用来渲染完成提示。
  readonly files: readonly string[];
}

// 目标目录已有文件时怎么办。调用方负责问用户；这里只执行已经做出的决定。
export type ExistingFilesStrategy = "remove" | "keep";

// 清空目录内容但保留目录本身和 .git：用户可能已经 git init 或 clone 过，删掉 .git 就是
// 删掉他的提交历史，那是脚手架绝对不该碰的东西（create-vite 的 emptyDir 同样跳过 .git）。
async function emptyDirectory(directory: string): Promise<void> {
  for (const entry of await readdir(directory)) {
    if (entry === ".git") {
      continue;
    }
    await rm(join(directory, entry), { recursive: true, force: true });
  }
}

/**
 * 把模板层依次落到 targetDirectory，再写入生成的 package.json。
 *
 * 目标目录不存在时由本函数创建；创建后任何一步失败都会整棵删掉，不给用户留半个项目。
 * 目录是用户预先建好的时不做删除——那是用户的目录，我们只清理自己造的东西。
 */
export async function scaffoldProject(
  targetDirectory: string,
  spec: ProjectSpec,
  existingFiles: ExistingFilesStrategy = "keep",
): Promise<ScaffoldResult> {
  const createdRoot = inspectTargetDirectory(targetDirectory) === "absent";
  const written: string[] = [];
  try {
    await mkdir(targetDirectory, { recursive: true });
    if (existingFiles === "remove" && !createdRoot) {
      await emptyDirectory(targetDirectory);
    }
    for (const layer of templateLayersFor(spec)) {
      await copyLayer(join(TEMPLATES_ROOT, layer), targetDirectory, written);
    }
    await writeFile(join(targetDirectory, "package.json"), renderPackageJson(spec), "utf8");
    written.push("package.json");
  } catch (error) {
    if (createdRoot) {
      await rm(targetDirectory, { recursive: true, force: true });
    }
    throw error;
  }
  return { files: [...written].sort((a, b) => a.localeCompare(b)) };
}
