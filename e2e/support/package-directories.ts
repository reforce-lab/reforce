import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

// 枚举 packages/ 下真正是包的目录（Issue #299）。返回值是相对 packagesRoot 的
// `<分组>/<包>`：packages/ 的一级目录是分组（kernel / web / …），包一律在第二级。
//
// 只按目录枚举会把「改过名的包留下的空壳」也算进来：#270 把 @reforce/context 更名
// @reforce/core、删掉源码后，凡在改名前构建过的工作区都留下 packages/context/，里面只剩
// dist/ + node_modules/ + .turbo/——三者全在 .gitignore 里，于是 git status 干净、
// git ls-files 为空，肉眼和 git 都看不见它，新 clone、新 worktree 和 CI 也都不复现。
// 消费方在模块顶层枚举，读不到 package.json 就是收集期 ENOENT，整个套件 0 个用例执行，
// 报告只剩一句「1 failed」，看不出坏的是哪条契约。跳过并点名，才把「你这儿有个孤儿目录」
// 这条唯一有用的信息说出来。
export async function listPackageDirectories(packagesRoot: string): Promise<readonly string[]> {
  const directories: string[] = [];
  for (const group of await listSubdirectories(packagesRoot)) {
    // 一级目录带 package.json，说明它是个放错层的包，不是分组。不先判这一下就会往它里面钻，
    // 把 src/ 之类当成「没有 package.json 的包目录」，然后建议你把真实源码目录删掉——正好是
    // 这个函数（#299）要消灭的那种误导。放错层的包 pnpm 也不会当 workspace 成员
    // （glob 是 packages/*/*），所以点名之后跳过，不混进发布契约的覆盖集里。
    if (await hasManifest(join(packagesRoot, group))) {
      console.warn(
        `Skipping packages/${group}: it carries a package.json, so it is a package sitting where ` +
          `a group directory belongs. Packages live at packages/<group>/<package>; move it under ` +
          `one, otherwise pnpm will not treat it as a workspace member either.`,
      );
      continue;
    }
    for (const name of await listSubdirectories(join(packagesRoot, group))) {
      const directory = `${group}/${name}`;
      if (await hasManifest(join(packagesRoot, directory))) {
        directories.push(directory);
        continue;
      }
      console.warn(
        `Skipping packages/${directory}: no package.json. It is most likely build output left ` +
          `behind by a renamed or deleted package (everything under it is gitignored, so git ` +
          `will not report it). Delete the directory to silence this warning.`,
      );
    }
  }
  return directories;
}

async function listSubdirectories(root: string): Promise<readonly string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function hasManifest(packageRoot: string): Promise<boolean> {
  try {
    const manifest = await stat(join(packageRoot, "package.json"));
    return manifest.isFile();
  } catch {
    return false;
  }
}
