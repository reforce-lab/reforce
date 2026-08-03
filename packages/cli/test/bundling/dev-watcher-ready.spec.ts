import { expect, test } from "bun:test";
import { posix, win32 } from "node:path";
import { isProjectWatchFile } from "@/bundling/dev-watcher-ready";

test("a gate watch input inside the project is watched", () => {
  const watched = isProjectWatchFile("/project", "/project/src/service.ts", posix);

  expect(watched).toBe(true);
});

test("the project root itself is not a watch file", () => {
  const watched = isProjectWatchFile("/project", "/project", posix);

  expect(watched).toBe(false);
});

test("a sibling directory reached by traversal is not watched", () => {
  const watched = isProjectWatchFile("/project", "/other/service.ts", posix);

  expect(watched).toBe(false);
});

test("generated, vcs and dependency directories are not watched", () => {
  expect(isProjectWatchFile("/project", "/project/.reforce/generated/beans.ts", posix)).toBe(false);
  expect(isProjectWatchFile("/project", "/project/.git/HEAD", posix)).toBe(false);
  expect(isProjectWatchFile("/project", "/project/dist/main.js", posix)).toBe(false);
  expect(isProjectWatchFile("/project", "/project/node_modules/pkg/index.js", posix)).toBe(false);
});

test("a nested dist directory is not watched", () => {
  const watched = isProjectWatchFile("/project", "/project/src/dist/keep.ts", posix);

  expect(watched).toBe(false);
});

test("a nested node_modules directory is not watched", () => {
  const watched = isProjectWatchFile(
    "/project",
    "/project/packages/app/node_modules/pkg/index.js",
    posix,
  );

  expect(watched).toBe(false);
});

test("a nested .reforce directory is not watched", () => {
  const watched = isProjectWatchFile("/project", "/project/sub/.reforce/x.ts", posix);

  expect(watched).toBe(false);
});

test("a nested .git directory is not watched", () => {
  const watched = isProjectWatchFile("/project", "/project/src/sub/.git/HEAD", posix);

  expect(watched).toBe(false);
});

test("a project root below an excluded directory name watches nothing", () => {
  const watched = isProjectWatchFile(
    "/tmp/node_modules/app",
    "/tmp/node_modules/app/src/service.ts",
    posix,
  );

  expect(watched).toBe(false);
});

test("a directory whose name merely starts with an excluded name is watched", () => {
  const watched = isProjectWatchFile("/project", "/project/src/distribution/x.ts", posix);

  expect(watched).toBe(true);
});

test("a nested excluded directory in a Windows path is not watched", () => {
  const watched = isProjectWatchFile("C:\\project", "C:\\project\\src\\dist\\keep.ts", win32);

  expect(watched).toBe(false);
});

test("a file on another Windows drive is not watched", () => {
  // win32 relative() across drives returns an absolute path instead of a ".." traversal, so the
  // traversal checks alone would let it through and the watcher would never report the file.
  const watched = isProjectWatchFile("C:\\project", "D:\\other\\service.ts", win32);

  expect(watched).toBe(false);
});

test("a Windows path inside the project is watched", () => {
  const watched = isProjectWatchFile("C:\\project", "C:\\project\\src\\service.ts", win32);

  expect(watched).toBe(true);
});
