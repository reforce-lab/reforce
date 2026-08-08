import { describe, expect, test } from "vitest";
import { templateLayersFor } from "@/project/template-layers";

describe("templateLayersFor", () => {
  test("base 永远排在引擎层之前——后写的覆盖先写的", () => {
    const layers = templateLayersFor({ name: "my-api", engine: "hono", lint: false });

    expect(layers).toEqual(["base", "engine-hono"]);
  });

  test("lint 打开时追加 lint 层", () => {
    const layers = templateLayersFor({ name: "my-api", engine: "fastify", lint: true });

    expect(layers).toEqual(["base", "engine-fastify", "lint"]);
  });

  test("lint 关闭时不含 lint 层", () => {
    const layers = templateLayersFor({ name: "my-api", engine: "node", lint: false });

    expect(layers).not.toContain("lint");
  });
});
