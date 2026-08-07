import { describe, expect, test } from "vitest";
import { ENGINES } from "@/engines";
import { createPackageJson, type ProjectSpec, renderPackageJson } from "@/project/package-json";

function specOf(overrides: Partial<ProjectSpec> = {}): ProjectSpec {
  return { name: "my-api", engine: "hono", lint: true, ...overrides };
}

describe("createPackageJson", () => {
  test.each(["hono", "fastify", "node"] as const)("engine %s 只带进自己的适配器包", (engine) => {
    const dependencies = createPackageJson(specOf({ engine })).dependencies as Record<
      string,
      string
    >;
    const adapters = Object.keys(dependencies).filter((name) => name.startsWith("@reforce/web-"));

    expect(adapters).toEqual([ENGINES[engine].packageName]);
  });

  test("引擎的第三方依赖不重复声明——它们是适配器包自己的 dependencies", () => {
    const dependencies = createPackageJson(specOf({ engine: "hono" })).dependencies as Record<
      string,
      string
    >;

    expect(dependencies).not.toHaveProperty("hono");
    expect(dependencies).not.toHaveProperty("@hono/node-server");
  });

  test("lint 打开时带 biome 依赖", () => {
    const spec = specOf({ lint: true });
    const devDependencies = createPackageJson(spec).devDependencies as Record<string, string>;

    expect(devDependencies).toHaveProperty("@biomejs/biome");
  });

  test("lint 关闭时不带 biome 依赖", () => {
    const spec = specOf({ lint: false });
    const devDependencies = createPackageJson(spec).devDependencies as Record<string, string>;

    expect(devDependencies).not.toHaveProperty("@biomejs/biome");
  });

  test("lint 打开时带 check 脚本", () => {
    const scripts = createPackageJson(specOf({ lint: true })).scripts as Record<string, string>;

    expect(scripts).toMatchObject({
      check: "biome check .",
      "check:write": "biome check --write .",
    });
  });

  test("lint 关闭时不带 check 脚本", () => {
    const scripts = createPackageJson(specOf({ lint: false })).scripts as Record<string, string>;

    expect(scripts).not.toHaveProperty("check");
  });

  test("三条运行命令与引擎无关，恒定存在", () => {
    const scripts = createPackageJson(specOf({ engine: "node" })).scripts as Record<string, string>;

    expect(scripts).toMatchObject({
      dev: "reforce dev",
      build: "reforce build",
      start: "reforce start",
    });
  });

  test("应用默认 private，挡住手滑的 npm publish", () => {
    expect(createPackageJson(specOf())).toHaveProperty("private", true);
  });

  test("依赖按字母序排列，diff 才稳定", () => {
    const dependencies = createPackageJson(specOf()).dependencies as Record<string, string>;
    const keys = Object.keys(dependencies);

    expect(keys).toEqual([...keys].sort((a, b) => a.localeCompare(b)));
  });
});

describe("renderPackageJson", () => {
  test("产出以换行收尾的合法 JSON", () => {
    const rendered = renderPackageJson(specOf());

    expect(rendered.endsWith("\n")).toBe(true);
    expect(() => JSON.parse(rendered)).not.toThrow();
  });
});
