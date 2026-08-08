import { createTemporaryProject, type TemporaryProject } from "@reforce/tooling-testing";
import { afterEach, describe, expect, test } from "vitest";
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

    const snapshot = loadEnvironmentSnapshot({ root, env: {} });

    expect(snapshot.values.get("A")).toBe("env");
    expect(snapshot.provenance.get("A")).toBe(".env");
  });

  test("keeps a process value on top even when it matches a file layer", async () => {
    const root = await projectWith({
      ".env": "A=base\n",
      ".env.production": "A=profile\n",
    });

    // Node 不把 .env 拷进 process.env：逐字符相等也是用户显式注入，process-env 恒为最高层
    const snapshot = loadEnvironmentSnapshot({
      root,
      env: { REFORCE_PROFILE: "production", A: "base" },
    });

    expect(snapshot.values.get("A")).toBe("base");
    expect(snapshot.provenance.get("A")).toBe("process-env");
  });

  test("keeps an unequal process value on top of every file layer", async () => {
    const root = await projectWith({
      ".env": "A=base\n",
      ".env.production": "A=profile\n",
    });

    const snapshot = loadEnvironmentSnapshot({
      root,
      env: { REFORCE_PROFILE: "production", A: "manual" },
    });

    expect(snapshot.values.get("A")).toBe("manual");
    expect(snapshot.provenance.get("A")).toBe("process-env");
  });

  test("warns when NODE_ENV points at an existing file outside the layering", async () => {
    const root = await projectWith({
      ".env": "A=env\n",
      ".env.production": "A=production\n",
    });

    const snapshot = loadEnvironmentSnapshot({
      root,
      env: { NODE_ENV: "production", REFORCE_PROFILE: "staging" },
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
    });
    const withoutNodeEnv = loadEnvironmentSnapshot({
      root: withFile,
      env: { REFORCE_PROFILE: "staging" },
    });
    const missingFile = loadEnvironmentSnapshot({
      root: withoutFile,
      env: { NODE_ENV: "production", REFORCE_PROFILE: "staging" },
    });
    // NODE_ENV 与 profile 同名时 .env.<NODE_ENV> 就是 profile 层本身，不在告警范围
    const sameAsProfile = loadEnvironmentSnapshot({
      root: withFile,
      env: { NODE_ENV: "production", REFORCE_PROFILE: "production" },
    });

    expect(withoutProfile.warnings).toHaveLength(0);
    expect(withoutNodeEnv.warnings).toHaveLength(0);
    expect(missingFile.warnings).toHaveLength(0);
    expect(sameAsProfile.warnings).toHaveLength(0);
  });

  test("keeps dollar-brace references literal because expansion is out of scope", async () => {
    // ADR 0005 决策 4.2：方言以 dotenv parse() 为准，不做 ${} 展开
    const root = await projectWith({ ".env": `A=\${HOME}/data\n` });

    const snapshot = loadEnvironmentSnapshot({ root, env: {} });

    expect(snapshot.values.get("A")).toBe(`\${HOME}/data`);
  });
});
