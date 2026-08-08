// 生成物里写死的依赖版本。改动这里必须同步 it/dependency-versions.spec.ts 的联网核对
// （`REFORCE_CHECK_LATEST=1 pnpm run test`），那条用例把每个版本和 registry 的 latest 比对，
// 落后即失败——"模板依赖保持最新"在这里是可执行的断言，不是一句承诺。
export const DEPENDENCY_VERSIONS = {
  zod: "^4.4.3",
} as const;

export const DEV_DEPENDENCY_VERSIONS = {
  "@biomejs/biome": "^2.5.7",
  "@types/node": "^26.1.2",
  typescript: "^7.0.2",
} as const;

// @reforce/* 尚未发布（#241：全部 private + 0.0.0，registry 上是 404）。生成的项目在发布
// 落地前 `pnpm install` 会失败，这是已知且已记录的状态，不是模板的缺陷。发布后回到 #240
// 把这里换成真实版本。
export const REFORCE_VERSION = "^0.1.0";
