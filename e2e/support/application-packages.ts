import { realpathSync } from "node:fs";
import { cp, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// fixture 应用副本的依赖装配（cli.spec 与 http.spec 共用）：不跑 pnpm install，手工把
// workspace 包落进临时副本的 node_modules——workspace 模式整包符号链接（保留包内
// node_modules），dist-only 模式只拷贝 package.json + dist（外加真 starter 的 meta 三件套
// 与纯运行时依赖），模拟用户只拿到发布产物的形态。

const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));
const coreRoot = join(workspaceRoot, "packages", "kernel", "core");
const configRoot = join(workspaceRoot, "packages", "kernel", "config");
const webRoot = join(workspaceRoot, "packages", "web", "web-core");
const webNodeRoot = join(workspaceRoot, "packages", "web", "web-node");
const webHonoRoot = join(workspaceRoot, "packages", "web", "web-hono");
const webFastifyRoot = join(workspaceRoot, "packages", "web", "web-fastify");
// @reforce/logging 是 @reforce/config 的运行时依赖（RFC 0011 L8，#250：绑定期的警告走引导
// 缓冲），@reforce/runtime 又是 logging 的——两者都必须随 config 一起落进 fixture，否则
// config 的 dist 在用户项目里 import 不到。
const loggingRoot = join(workspaceRoot, "packages", "observability", "logging");
const runtimeRoot = join(workspaceRoot, "packages", "kernel", "runtime");
const toolingTsconfigRoot = join(workspaceRoot, "tooling", "tsconfig");
const nodeTypesRoot = fileURLToPath(new URL(".", import.meta.resolve("@types/node/package.json")));
const radashiRoot = fileURLToPath(new URL("..", import.meta.resolve("radashi")));

function link(target: string, path: string): Promise<void> {
  return symlink(target, path, process.platform === "win32" ? "junction" : "dir");
}

// 换引擎的 e2e 需要三个引擎包同时可解析（fixture 只改 import，不动 controller/middleware）。
// 只在 workspace 模式下装：dist-only 模式是「用户只拿到发布产物」的形态，那条链路由
// web-node 一家代表就够，不必为它把三份 dist 都搬一遍。
const extraEngineRoots: Readonly<Record<string, string>> = {
  "web-hono": webHonoRoot,
  "web-fastify": webFastifyRoot,
};

export async function installApplicationPackages(
  projectRoot: string,
  contextDistribution: "dist-only" | "workspace" = "workspace",
  extraEngines: readonly string[] = [],
): Promise<void> {
  const scopeRoot = join(projectRoot, "node_modules", "@reforce");
  const typesScopeRoot = join(projectRoot, "node_modules", "@types");
  const coreTarget = join(scopeRoot, "core");
  await Promise.all([
    mkdir(scopeRoot, { recursive: true }),
    mkdir(typesScopeRoot, { recursive: true }),
  ]);
  await Promise.all([
    link(toolingTsconfigRoot, join(scopeRoot, "tooling-tsconfig")),
    link(nodeTypesRoot, join(typesScopeRoot, "node")),
    cp(radashiRoot, join(projectRoot, "node_modules", "radashi"), { recursive: true }),
    // @swc/helpers 是 @reforce/web-node dist 的运行时依赖（标准装饰器经 SWC 编译产生
    // helper import）；两种分发模式都以真实包落地。
    cp(
      realpathSync(join(webNodeRoot, "node_modules", "@swc", "helpers")),
      join(projectRoot, "node_modules", "@swc", "helpers"),
      { recursive: true },
    ),
    // @standard-schema/spec 是 @reforce/web-core 声明的运行时依赖，且它的类型出现在 web 的
    // 公开 d.ts 里（`import type { StandardSchemaV1 }`）。真实 npm install 必然带上它，
    // 副本不带就会让消费者 typecheck 报 TS2307——那是 harness 缺口，不是发布缺陷。
    cp(
      realpathSync(join(webRoot, "node_modules", "@standard-schema", "spec")),
      join(projectRoot, "node_modules", "@standard-schema", "spec"),
      { recursive: true },
    ),
  ]);
  const configTarget = join(scopeRoot, "config");
  const webTarget = join(scopeRoot, "web-core");
  const webNodeTarget = join(scopeRoot, "web-node");
  const loggingTarget = join(scopeRoot, "logging");
  const runtimeTarget = join(scopeRoot, "runtime");
  if (contextDistribution === "workspace") {
    await Promise.all([
      link(coreRoot, coreTarget),
      link(configRoot, configTarget),
      link(webRoot, webTarget),
      link(webNodeRoot, webNodeTarget),
      link(loggingRoot, loggingTarget),
      link(runtimeRoot, runtimeTarget),
      ...extraEngines.map((name) => {
        const root = extraEngineRoots[name];
        if (root === undefined) {
          throw new Error(`Unknown extra engine package: ${name}`);
        }
        return link(root, join(scopeRoot, name));
      }),
    ]);
    return;
  }
  await Promise.all([
    mkdir(coreTarget),
    mkdir(configTarget),
    mkdir(webTarget),
    mkdir(webNodeTarget),
    mkdir(loggingTarget),
    mkdir(runtimeTarget),
  ]);
  await Promise.all([
    cp(join(coreRoot, "package.json"), join(coreTarget, "package.json")),
    cp(join(coreRoot, "dist"), join(coreTarget, "dist"), { recursive: true }),
    cp(join(configRoot, "package.json"), join(configTarget, "package.json")),
    cp(join(configRoot, "dist"), join(configTarget, "dist"), { recursive: true }),
    cp(join(webRoot, "package.json"), join(webTarget, "package.json")),
    cp(join(webRoot, "dist"), join(webTarget, "dist"), { recursive: true }),
    // web-core 一个 bean 都没有，但它的 meta 是引擎包契约坐标的落点：web-node 的 provides 写的
    // 是 `@reforce/web-core#WebEngineAdapter`，链接期要靠这份户口表把它解析回 dist（#369）。
    cp(join(webRoot, "reforce-meta.json"), join(webTarget, "reforce-meta.json")),
    cp(join(loggingRoot, "package.json"), join(loggingTarget, "package.json")),
    cp(join(loggingRoot, "dist"), join(loggingTarget, "dist"), { recursive: true }),
    // @reforce/logging 升格 starter 后（RFC 0011 勘误，#242）分发面同样带 meta。
    cp(join(loggingRoot, "reforce-meta.json"), join(loggingTarget, "reforce-meta.json")),
    cp(join(runtimeRoot, "package.json"), join(runtimeTarget, "package.json")),
    cp(join(runtimeRoot, "dist"), join(runtimeTarget, "dist"), { recursive: true }),
    cp(join(webNodeRoot, "package.json"), join(webNodeTarget, "package.json")),
    cp(join(webNodeRoot, "dist"), join(webNodeTarget, "dist"), { recursive: true }),
    // 真 starter 的分发面不止 dist：`reforce lib` 产出的 meta 挂在包根 exports 上，
    // dist-only 分发必须一并携带（ADR 0004 决策 2）。
    cp(join(webNodeRoot, "reforce-meta.json"), join(webNodeTarget, "reforce-meta.json")),
    // dotenv 是 @reforce/config 唯一的运行时依赖；dist-only 拷贝没有包内 node_modules，
    // 把真实包（穿透 pnpm 的符号链接）落到应用 node_modules。
    cp(
      realpathSync(join(configRoot, "node_modules", "dotenv")),
      join(projectRoot, "node_modules", "dotenv"),
      { recursive: true },
    ),
    // find-my-way 是 @reforce/web-node dist 的运行时依赖（#211）。这里用符号链接而不是像
    // dotenv 那样拷贝：它自己还有传递依赖（fast-querystring / safe-regex2 …），而 pnpm 把
    // 这些依赖放在 store 里 find-my-way 真实路径的同级；Node 从真实路径解析依赖，链过去就
    // 全都能找到，拷贝则只会搬来孤立的一层。
    link(
      realpathSync(join(webNodeRoot, "node_modules", "find-my-way")),
      join(projectRoot, "node_modules", "find-my-way"),
    ),
  ]);
}
