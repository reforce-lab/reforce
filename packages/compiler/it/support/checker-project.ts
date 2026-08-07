import { readdirSync, readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { toPortablePath } from "@reforce/primitives";
import { createTemporaryProject } from "@reforce/tooling-testing";
import {
  type CheckerLease,
  type CheckerSession,
  createCheckerSession,
} from "@/typescript/checker-session";

// 真 checker 集成测试的项目 harness(RFC 0012 S1,#273):临时盘面 + tsgo 会话 + 位置定位。

export interface CheckerHarness {
  readonly root: string;
  readonly tsconfigPath: string;
  readonly session: CheckerSession;
  lease(): CheckerLease;
  filePath(relativePath: string): string;
  // UTF-16 code unit offset,取第 nth 次出现的 token 起点。
  offsetOf(relativePath: string, token: string, nth?: number): number;
  fileIdOf(declarationPath: string): string | undefined;
  cleanup(): Promise<void>;
}

const tsconfigContent = `${JSON.stringify({
  compilerOptions: {
    target: "esnext",
    module: "esnext",
    moduleResolution: "bundler",
    strict: true,
    noEmit: true,
  },
  include: ["src"],
})}\n`;

export async function createCheckerHarness(
  sources: Readonly<Record<string, string>>,
): Promise<CheckerHarness> {
  const temporary = await createTemporaryProject({
    "tsconfig.json": tsconfigContent,
    src: { ...sources },
  });
  const root = await realpath(temporary.projectRoot);
  const tsconfigPath = path.join(root, "tsconfig.json");
  const session = createCheckerSession({ cwd: root });
  const trackedFiles = () =>
    readdirSync(path.join(root, "src")).map((name) => path.join(root, "src", name));
  return {
    root,
    tsconfigPath,
    session,
    lease() {
      return session.lease({ tsconfigPath, trackedFiles: trackedFiles() });
    },
    filePath(relativePath) {
      return path.join(root, relativePath);
    },
    offsetOf(relativePath, token, nth = 0) {
      const text = readFileSync(path.join(root, relativePath), "utf8");
      let index = -1;
      for (let i = 0; i <= nth; i += 1) {
        index = text.indexOf(token, index + 1);
      }
      if (index < 0) {
        throw new Error(`Token not found in ${relativePath}: ${token}`);
      }
      return index;
    },
    fileIdOf(declarationPath) {
      const relativePath = path.relative(root, declarationPath);
      if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
        return undefined;
      }
      return toPortablePath(relativePath);
    },
    async cleanup() {
      session.close();
      await temporary.cleanup();
    },
  };
}
