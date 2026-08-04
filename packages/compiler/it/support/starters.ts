import type { ProjectTree } from "@reforce/tooling-testing";

// ADR 0004（#120）决策 2/5：meta 经 exports subpath `./reforce-meta` 暴露，注册 handle 经
// `./reforce` 提供。M1 的 IT 以手写 meta JSON 为唯一 starter 输入（#145），本构造器手写这两个契约面。

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
  /** 覆盖 package.json 的 exports；缺省提供 "." / "./reforce" / "./reforce-meta" 三个 subpath。 */
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
        "./reforce": { types: "./reforce.d.ts", default: "./reforce.js" },
        "./reforce-meta": "./reforce-meta.json",
      },
    })}\n`,
    "reforce-meta.json": `${JSON.stringify(options.meta, undefined, 2)}\n`,
    "reforce.d.ts": [
      'import type { StarterDefinition } from "@reforce/context";',
      "declare const starter: StarterDefinition;",
      "export default starter;",
      "",
    ].join("\n"),
    "reforce.js": "export default Object.freeze({});\n",
    dist: options.dist,
  };
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
