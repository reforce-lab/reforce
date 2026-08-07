import type { ProjectTree } from "@reforce/tooling-testing";

// ADR 0004（#120）决策 2/5：meta 经 exports subpath `./reforce-meta` 暴露；注册 handle 是包作者
// 手写在主入口的具名导出，不占 subpath。M1 的 IT 以手写 meta JSON 为唯一 starter 输入（#145），
// 本构造器手写 meta 那一面；handle 由各用例按需写进自己的 dist 声明。

interface MetaSourceSpan {
  readonly file: string;
  readonly start: { readonly offset: number; readonly line: number; readonly character: number };
  readonly end: { readonly offset: number; readonly line: number; readonly character: number };
}

export function starterMetaSpan(file: string, offset = 0): MetaSourceSpan {
  return {
    file,
    start: { offset, line: 0, character: offset },
    end: { offset: offset + 1, line: 0, character: offset + 1 },
  };
}

export interface StarterPackageOptions {
  readonly name: string;
  readonly version?: string;
  /** 原样序列化进 reforce-meta.json；负向用例可传坏形状。 */
  readonly meta: unknown;
  readonly dist: ProjectTree;
  /** 覆盖 package.json 的 exports；缺省提供 "." / "./reforce-meta" 两个 subpath。 */
  readonly exports?: Record<string, unknown>;
}

export function starterPackage(options: StarterPackageOptions): ProjectTree {
  return {
    "package.json": `${JSON.stringify({
      name: options.name,
      version: options.version ?? "1.0.0",
      type: "module",
      exports: options.exports ?? {
        ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
        "./reforce-meta": "./reforce-meta.json",
      },
    })}\n`,
    "reforce-meta.json": `${JSON.stringify(options.meta, undefined, 2)}\n`,
    dist: options.dist,
  };
}

/** 注册 handle 的 dist 声明行；starter 包作者手写在主入口，链接期只当普通具名导入解析。 */
export function starterHandleDeclaration(name: string): string {
  return `export declare const ${name}: import("@reforce/core").StarterDefinition;`;
}

// 运行时那一半必须同步存在：应用源码里的 `import { <handle> } from "<pkg>"` 会被打进产物，
// dist 只有声明没有导出时，执行到 ESM 具名绑定就是 SyntaxError。值等价于 defineStarter()
// 的返回物（冻结空对象），fixture 不为此依赖 @reforce/core。
export function starterHandleRuntime(name: string): string {
  return `export const ${name} = Object.freeze({});`;
}

export function contractPackage(options: {
  readonly name: string;
  readonly version?: string;
  readonly dist: ProjectTree;
}): ProjectTree {
  return {
    "package.json": `${JSON.stringify({
      name: options.name,
      version: options.version ?? "1.0.0",
      type: "module",
      exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
    })}\n`,
    dist: options.dist,
  };
}

// writeProjectTree 的条目名不允许含 "/"，scoped 包名必须拆成嵌套目录后再合并到同一棵树里。
export function nodeModulesTree(packages: Record<string, ProjectTree>): ProjectTree {
  const plain: Record<string, ProjectTree> = {};
  const scopes = new Map<string, Record<string, ProjectTree>>();
  for (const [packageName, tree] of Object.entries(packages)) {
    const [scope, name, ...rest] = packageName.split("/");
    if (scope === undefined || rest.length > 0) {
      throw new Error(`Invalid package name: ${packageName}`);
    }
    if (name === undefined) {
      plain[scope] = tree;
      continue;
    }
    const scopeTree = scopes.get(scope) ?? {};
    scopes.set(scope, scopeTree);
    scopeTree[name] = tree;
  }
  return { ...plain, ...Object.fromEntries(scopes) };
}
