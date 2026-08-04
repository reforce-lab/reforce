import { afterEach, describe, expect, test } from "bun:test";
import { createTemporaryProject, type TemporaryProject } from "@reforce/tooling-testing";
import { loadEnvironmentSnapshot } from "@/binding/env-layers";

const projects: TemporaryProject[] = [];

afterEach(async () => {
  await Promise.all(projects.splice(0).map((project) => project.cleanup()));
});

async function projectWith(tree: Record<string, string>): Promise<string> {
  const project = await createTemporaryProject(tree);
  projects.push(project);
  return project.projectRoot;
}

describe("loadEnvironmentSnapshot", () => {
  test("merges the four layers from .env up to process env", async () => {
    const root = await projectWith({
      ".env": "A=env\nB=env\nC=env\n",
      ".env.local": "A=local\nB=local\n",
      ".env.production": "A=production\n",
    });

    const snapshot = loadEnvironmentSnapshot({
      root,
      env: { REFORCE_PROFILE: "production", A: "process" },
      bunAutoLoaded: false,
    });

    expect(snapshot.values.get("A")).toBe("process");
    expect(snapshot.values.get("B")).toBe("local");
    expect(snapshot.values.get("C")).toBe("env");
  });

  test("labels provenance with the winning layer per key", async () => {
    const root = await projectWith({
      ".env": "A=env\nB=env\nC=env\nD=env\n",
      ".env.local": "B=local\nC=local\nD=local\n",
      ".env.production": "C=production\nD=production\n",
    });

    const snapshot = loadEnvironmentSnapshot({
      root,
      env: { REFORCE_PROFILE: "production", D: "process" },
      bunAutoLoaded: false,
    });

    expect(snapshot.provenance.get("A")).toBe(".env");
    expect(snapshot.provenance.get("B")).toBe(".env.local");
    expect(snapshot.provenance.get("C")).toBe(".env.production");
    expect(snapshot.provenance.get("D")).toBe("process-env");
  });

  test("skips the profile file when REFORCE_PROFILE is not set", async () => {
    const root = await projectWith({
      ".env": "A=env\n",
      ".env.production": "A=production\n",
    });

    const snapshot = loadEnvironmentSnapshot({ root, env: {}, bunAutoLoaded: false });

    expect(snapshot.values.get("A")).toBe("env");
    expect(snapshot.provenance.get("A")).toBe(".env");
  });

  test("demotes a Bun-mirrored process value so the profile file wins", async () => {
    const root = await projectWith({
      ".env": "A=base\n",
      ".env.production": "A=profile\n",
    });

    // Bun 启动时把 .env 的 A=base 拷进了 process.env；逐字符相等 ⇒ 降级，
    // .env.<profile> 得以覆盖（ADR 0005 决策 4.3）
    const snapshot = loadEnvironmentSnapshot({
      root,
      env: { REFORCE_PROFILE: "production", A: "base" },
      bunAutoLoaded: true,
    });

    expect(snapshot.values.get("A")).toBe("profile");
    expect(snapshot.provenance.get("A")).toBe(".env.production");
  });

  test("demotes a Bun-mirrored process value back to its file provenance", async () => {
    const root = await projectWith({
      ".env": "A=base\n",
      ".env.local": "B=local\n",
    });

    const snapshot = loadEnvironmentSnapshot({
      root,
      env: { A: "base", B: "local" },
      bunAutoLoaded: true,
    });

    expect(snapshot.provenance.get("A")).toBe(".env");
    expect(snapshot.provenance.get("B")).toBe(".env.local");
  });

  test("keeps an unequal process value on top of every file layer", async () => {
    const root = await projectWith({
      ".env": "A=base\n",
      ".env.production": "A=profile\n",
    });

    const snapshot = loadEnvironmentSnapshot({
      root,
      env: { REFORCE_PROFILE: "production", A: "manual" },
      bunAutoLoaded: true,
    });

    expect(snapshot.values.get("A")).toBe("manual");
    expect(snapshot.provenance.get("A")).toBe("process-env");
  });

  test("never demotes when the runtime did not auto-load env files", async () => {
    const root = await projectWith({
      ".env": "A=base\n",
      ".env.production": "A=profile\n",
    });

    const snapshot = loadEnvironmentSnapshot({
      root,
      env: { REFORCE_PROFILE: "production", A: "base" },
      bunAutoLoaded: false,
    });

    expect(snapshot.values.get("A")).toBe("base");
    expect(snapshot.provenance.get("A")).toBe("process-env");
  });

  // Bun 1.3.14 在 NODE_ENV=test 下跳过 .env.local（CRA/Vite 惯例）：镜像若仍按
  // ".env + .env.local" 合成，.env 的拷贝会被误判成外部注入而压制 .env.local。
  // 该回归由 compiler 的可执行 IT（bun test 环境）首次暴露。
  test("demotes a Bun copy under NODE_ENV=test where Bun skips .env.local", async () => {
    const root = await projectWith({
      ".env": "PORT=3000\n",
      ".env.local": "PORT=4000\n",
    });

    const snapshot = loadEnvironmentSnapshot({
      root,
      // Bun 在 NODE_ENV=test 下只拷贝 .env：process 值是 3000 而非 .env.local 的 4000。
      env: { NODE_ENV: "test", PORT: "3000" },
      bunAutoLoaded: true,
    });

    expect(snapshot.values.get("PORT")).toBe("4000");
    expect(snapshot.provenance.get("PORT")).toBe(".env.local");
  });

  test("demotes a Bun copy sourced from .env.{NODE_ENV} and drops it from the layering", async () => {
    const root = await projectWith({
      ".env": "A=env\n",
      ".env.test": "A=test-file\nONLY_TEST=copied\n",
    });

    const snapshot = loadEnvironmentSnapshot({
      root,
      // Bun 在 NODE_ENV=test 下合成 .env < .env.test：两个键的 process 值都来自拷贝。
      env: { NODE_ENV: "test", A: "test-file", ONLY_TEST: "copied" },
      bunAutoLoaded: true,
    });

    // .env.test 不进框架分层：A 回落到 .env，独有键整个消失（Node/Deno 下它本不存在）。
    expect(snapshot.values.get("A")).toBe("env");
    expect(snapshot.provenance.get("A")).toBe(".env");
    expect(snapshot.values.has("ONLY_TEST")).toBe(false);
  });

  test("mirrors .env.development when NODE_ENV is unset", async () => {
    const root = await projectWith({
      ".env.development": "DEV_ONLY=copied\n",
    });

    const snapshot = loadEnvironmentSnapshot({
      root,
      env: { DEV_ONLY: "copied" },
      bunAutoLoaded: true,
    });

    expect(snapshot.values.has("DEV_ONLY")).toBe(false);
  });

  test("warns when NODE_ENV points at an existing file outside the layering", async () => {
    const root = await projectWith({
      ".env": "A=env\n",
      ".env.production": "A=production\n",
    });

    const snapshot = loadEnvironmentSnapshot({
      root,
      env: { NODE_ENV: "production", REFORCE_PROFILE: "staging" },
      bunAutoLoaded: false,
    });

    expect(snapshot.warnings).toHaveLength(1);
    expect(snapshot.warnings[0]).toContain(".env.production");
    expect(snapshot.warnings[0]).toContain("REFORCE_PROFILE");
  });

  test("does not warn when any of the three warning conditions is missing", async () => {
    const withFile = await projectWith({ ".env.production": "A=production\n" });
    const withoutFile = await projectWith({ ".env": "A=env\n" });

    const withoutProfile = loadEnvironmentSnapshot({
      root: withFile,
      env: { NODE_ENV: "production" },
      bunAutoLoaded: false,
    });
    const withoutNodeEnv = loadEnvironmentSnapshot({
      root: withFile,
      env: { REFORCE_PROFILE: "staging" },
      bunAutoLoaded: false,
    });
    const missingFile = loadEnvironmentSnapshot({
      root: withoutFile,
      env: { NODE_ENV: "production", REFORCE_PROFILE: "staging" },
      bunAutoLoaded: false,
    });
    // NODE_ENV 与 profile 同名时 .env.<NODE_ENV> 就是 profile 层本身，不在告警范围
    const sameAsProfile = loadEnvironmentSnapshot({
      root: withFile,
      env: { NODE_ENV: "production", REFORCE_PROFILE: "production" },
      bunAutoLoaded: false,
    });

    expect(withoutProfile.warnings).toHaveLength(0);
    expect(withoutNodeEnv.warnings).toHaveLength(0);
    expect(missingFile.warnings).toHaveLength(0);
    expect(sameAsProfile.warnings).toHaveLength(0);
  });

  test("keeps dollar-brace references literal because expansion is out of scope", async () => {
    // ADR 0005 决策 4.2：方言以 dotenv parse() 为准，不做 ${} 展开
    const root = await projectWith({ ".env": `A=\${HOME}/data\n` });

    const snapshot = loadEnvironmentSnapshot({ root, env: {}, bunAutoLoaded: false });

    expect(snapshot.values.get("A")).toBe(`\${HOME}/data`);
  });
});
