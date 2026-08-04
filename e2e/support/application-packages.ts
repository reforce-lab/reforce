import { realpathSync } from "node:fs";
import { cp, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// fixture 应用副本的依赖装配（cli.spec 与 http.spec 共用）：不跑 bun install，手工把
// workspace 包落进临时副本的 node_modules——workspace 模式整包符号链接（保留包内
// node_modules），dist-only 模式只拷贝 package.json + dist（外加真 starter 的 meta 三件套
// 与纯运行时依赖），模拟用户只拿到发布产物的形态。

const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));
const contextRoot = join(workspaceRoot, "packages", "context");
const configRoot = join(workspaceRoot, "packages", "config");
const webRoot = join(workspaceRoot, "packages", "web");
const webBunRoot = join(workspaceRoot, "packages", "web-bun");
const toolingTsconfigRoot = join(workspaceRoot, "tooling", "tsconfig");
const bunTypesRoot = fileURLToPath(new URL(".", import.meta.resolve("@types/bun/package.json")));
const radashiRoot = fileURLToPath(new URL("..", import.meta.resolve("radashi")));

function link(target: string, path: string): Promise<void> {
  return symlink(target, path, process.platform === "win32" ? "junction" : "dir");
}

export async function installApplicationPackages(
  projectRoot: string,
  contextDistribution: "dist-only" | "workspace" = "workspace",
): Promise<void> {
  const scopeRoot = join(projectRoot, "node_modules", "@reforce");
  const typesScopeRoot = join(projectRoot, "node_modules", "@types");
  const contextTarget = join(scopeRoot, "context");
  await Promise.all([
    mkdir(scopeRoot, { recursive: true }),
    mkdir(typesScopeRoot, { recursive: true }),
  ]);
  await Promise.all([
    link(toolingTsconfigRoot, join(scopeRoot, "tooling-tsconfig")),
    link(bunTypesRoot, join(typesScopeRoot, "bun")),
    cp(radashiRoot, join(projectRoot, "node_modules", "radashi"), { recursive: true }),
    // @swc/helpers 是 @reforce/web-bun dist 的运行时依赖（标准装饰器经 SWC 编译产生
    // helper import）；两种分发模式都以真实包落地。
    cp(
      realpathSync(join(webBunRoot, "node_modules", "@swc", "helpers")),
      join(projectRoot, "node_modules", "@swc", "helpers"),
      { recursive: true },
    ),
  ]);
  const configTarget = join(scopeRoot, "config");
  const webTarget = join(scopeRoot, "web");
  const webBunTarget = join(scopeRoot, "web-bun");
  if (contextDistribution === "workspace") {
    await Promise.all([
      link(contextRoot, contextTarget),
      link(configRoot, configTarget),
      link(webRoot, webTarget),
      link(webBunRoot, webBunTarget),
    ]);
    return;
  }
  await Promise.all([
    mkdir(contextTarget),
    mkdir(configTarget),
    mkdir(webTarget),
    mkdir(webBunTarget),
  ]);
  await Promise.all([
    cp(join(contextRoot, "package.json"), join(contextTarget, "package.json")),
    cp(join(contextRoot, "dist"), join(contextTarget, "dist"), { recursive: true }),
    cp(join(configRoot, "package.json"), join(configTarget, "package.json")),
    cp(join(configRoot, "dist"), join(configTarget, "dist"), { recursive: true }),
    cp(join(webRoot, "package.json"), join(webTarget, "package.json")),
    cp(join(webRoot, "dist"), join(webTarget, "dist"), { recursive: true }),
    cp(join(webBunRoot, "package.json"), join(webBunTarget, "package.json")),
    cp(join(webBunRoot, "dist"), join(webBunTarget, "dist"), { recursive: true }),
    // 真 starter 的分发面不止 dist：`reforce lib` 产出的 meta 三件套挂在包根 exports 上，
    // dist-only 分发必须一并携带（ADR 0004 决策 2）。
    cp(join(webBunRoot, "reforce-meta.json"), join(webBunTarget, "reforce-meta.json")),
    cp(join(webBunRoot, "reforce.js"), join(webBunTarget, "reforce.js")),
    cp(join(webBunRoot, "reforce.d.ts"), join(webBunTarget, "reforce.d.ts")),
    // dotenv 是 @reforce/config 唯一的运行时依赖；dist-only 拷贝没有包内 node_modules，
    // 把真实包（穿透 bun 的符号链接）落到应用 node_modules。
    cp(
      realpathSync(join(configRoot, "node_modules", "dotenv")),
      join(projectRoot, "node_modules", "dotenv"),
      { recursive: true },
    ),
  ]);
}
