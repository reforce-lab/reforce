// rspack hot-update 产物的命名，写入侧与读取侧共用一份：bundling/dev-watch.ts 用它配置
// output.hotUpdate*Filename，dev-runtime.ts 用它识别「manifest 已被下一次编译删掉」并把那次 check
// 当成「无更新」放过。两侧此前各写各的（一个是模板字符串，一个是手抄的正则），改了写入侧不会让读取侧
// 编译失败，只会让容错分支静默失配，于是 Issue #46 的失败模式重新出现且没有测试信号。
const updatesDirectory = "updates";

// manifest 的后缀必须与 chunk 后缀不同名：`[runtime]` 与入口 chunk 的 `[id]` 都是 `main`，共用后缀
// 会让两份产物互相覆盖。两者都是 `.mjs` 而不是 `.json`——`import` chunk-loading 运行时读的是
// `obj.default`，manifest 内容是 ES module，Bun 会按扩展名给 `.json` 选 JSON loader 并解析失败。
const manifestSuffix = "hot-update-manifest.mjs";
const chunkSuffix = "hot-update.mjs";

export const hotUpdateDirectory = `${updatesDirectory}/`;
export const hotUpdateChunkFilename = `${updatesDirectory}/[id].[fullhash].${chunkSuffix}`;
export const hotUpdateManifestFilename = `${updatesDirectory}/[runtime].[fullhash].${manifestSuffix}`;

// 待匹配的字符串可能是 URL、文件路径或错误消息正文，所以只锚定「/updates/<something>.<后缀>」这一段。
// 后缀里的 `.` 要转义成正则字面量，其余部分都是普通字符。
export const hotUpdateManifestPattern = new RegExp(
  `(?:^|/)${updatesDirectory}/[^/]+\\.${manifestSuffix.replaceAll(".", "\\.")}(?:\\b|["'])`,
  "u",
);
