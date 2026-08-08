import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { CheckerUnavailableError } from "@/typescript/checker-errors";
import {
  type CheckerPort,
  createTypeQuery,
  type ProgramPort,
  type TypeQuery,
} from "@/typescript/type-query";
import { API, type APIOptions } from "@/typescript/unstable-api";

// checker 会话 supervisor(RFC 0012 S1,#273):tsgo 子进程的生命周期归这里管,门面只管查询。
// - 懒 spawn:lease() 零成本,首次真正查询才 new API + updateSnapshot——普通 compile 不消费
//   checker 时不为 tsgo 付任何进程/快照成本。
// - 崩溃无自动恢复(上游行为):任何 IPC 异常都标记会话崩溃、best-effort 关闭子进程,当次查询抛
//   CheckerUnavailableError;下一个 lease 重新 spawn,重建全量 snapshot。
// - snapshot 跨 compile 保留复用:后续 lease 只对 tracked 文件做内容哈希差集,经
//   updateSnapshot({fileChanges}) 复用 server 端 program(增量实测 <1ms,冷开 ~26ms/小项目)。
// - 句柄跨代安全由 type-query 的 generation WeakSet 负责,这里只负责让代号单调递增。

export interface CheckerProjectRequest {
  readonly tsconfigPath: string;
  // 参与差集的文件全集,口径取现管线 ProjectState.parsedConfig.fileNames。node_modules 变化
  // server 感知不到,依赖变更走上游 resolveProject 重建(tsconfig/lock 哈希)兜底。
  readonly trackedFiles: readonly string[];
}

export interface CheckerLease {
  readonly query: TypeQuery;
  retire(): void;
}

export interface CheckerSession {
  lease(request: CheckerProjectRequest): CheckerLease;
  close(): void;
}

// API 依赖面收窄成结构接口:真实 API 实例直接结构赋值,单测替身不起子进程。
// 替身理由:边界是 tsgo 子进程的 spawn 与同步 IPC。
// 数组是可变形状:上游 UpdateSnapshotParams 的 FileChanges 就是可变的 DocumentIdentifier[]。
export interface UnstableApiPort {
  updateSnapshot(params: {
    openProjects?: string[];
    fileChanges?: { changed?: string[]; created?: string[]; deleted?: string[] };
  }): UnstableSnapshotPort;
  close(): void;
}

export interface UnstableSnapshotPort {
  getProject(tsconfigPath: string): UnstableProjectPort | undefined;
  dispose(): void;
}

export interface UnstableProjectPort {
  readonly checker: CheckerPort;
  readonly program: ProgramPort;
}

export interface CheckerSessionOptions {
  readonly cwd?: string;
  readonly collectTiming?: boolean;
  readonly spawnApi?: (options: APIOptions) => UnstableApiPort;
}

export interface FileChangeSet {
  readonly changed: string[];
  readonly created: string[];
  readonly deleted: string[];
}

// 纯差集计算,独立导出便于单测钉行为:changed/created/deleted 语义对齐 UpdateSnapshotParams。
export function computeFileChanges(
  previous: ReadonlyMap<string, string>,
  next: ReadonlyMap<string, string>,
): FileChangeSet {
  const changed: string[] = [];
  const created: string[] = [];
  const deleted: string[] = [];
  for (const [file, hash] of next) {
    const previousHash = previous.get(file);
    if (previousHash === undefined) {
      created.push(file);
    } else if (previousHash !== hash) {
      changed.push(file);
    }
  }
  for (const file of previous.keys()) {
    if (!next.has(file)) {
      deleted.push(file);
    }
  }
  return { changed, created, deleted };
}

function hashTrackedFiles(trackedFiles: readonly string[]): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const file of trackedFiles) {
    let content: Buffer;
    try {
      content = readFileSync(file);
    } catch {
      // 读不到按"已删除"处理:文件不进 next 集合,差集里自然落入 deleted。
      continue;
    }
    hashes.set(file, createHash("sha256").update(content).digest("hex"));
  }
  return hashes;
}

interface OpenProject {
  readonly checker: CheckerPort;
  readonly program: ProgramPort;
}

export function createCheckerSession(options: CheckerSessionOptions = {}): CheckerSession {
  const spawnApi = options.spawnApi ?? ((apiOptions: APIOptions) => new API(apiOptions));
  let api: UnstableApiPort | undefined;
  let snapshot: UnstableSnapshotPort | undefined;
  let closed = false;
  let generation = 0;
  // 每个 tsconfig 一份 tracked 文件哈希:openProjects 在 server 端 ref-count 且跨 snapshot
  // 持续,表里有键即项目已开。同一文件被两个项目 track 时最多重复上报一次 changed,server
  // 重读文件是幂等的。
  const trackedHashesByProject = new Map<string, Map<string, string>>();
  const exitHandler = () => {
    // 进程退出兜底:漏掉 close() 也不留孤儿 tsgo。SIGKILL 杀宿主时无法兜底,子进程随
    // channel 断开自行退出。
    api?.close();
  };

  function failUnavailable(message: string, cause?: unknown): never {
    if (api !== undefined) {
      try {
        api.close();
      } catch {
        // 崩溃后的 close 只是 best-effort 清理,失败无事可做。
      }
      process.off("exit", exitHandler);
    }
    api = undefined;
    snapshot = undefined;
    trackedHashesByProject.clear();
    throw new CheckerUnavailableError(message, cause);
  }

  function ensureApi(): UnstableApiPort {
    if (api === undefined) {
      // APIOptions 是 tsgo 的第三方类型，它把 collectTiming 声明成严格可选，所以缺省时这个键
      // 必须整个不写，而不是写成 undefined（#367）。
      api = spawnApi({
        cwd: options.cwd ?? process.cwd(),
        ...(options.collectTiming === undefined ? {} : { collectTiming: options.collectTiming }),
      });
      process.on("exit", exitHandler);
    }
    return api;
  }

  function refreshSnapshot(
    channel: UnstableApiPort,
    tsconfigPath: string,
    needsOpen: boolean,
    changes: FileChangeSet,
  ): UnstableSnapshotPort {
    const hasChanges =
      changes.changed.length > 0 || changes.created.length > 0 || changes.deleted.length > 0;
    const current = snapshot;
    if (current !== undefined && !needsOpen && !hasChanges) {
      return current;
    }
    const next = channel.updateSnapshot({
      ...(needsOpen ? { openProjects: [tsconfigPath] } : {}),
      // 项目首开时全部文件由 server 从盘上读,差集只在复用 snapshot 时上报。
      ...(hasChanges && !needsOpen ? { fileChanges: changes } : {}),
    });
    current?.dispose();
    snapshot = next;
    return next;
  }

  function openProject(request: CheckerProjectRequest): OpenProject {
    if (closed) {
      throw new CheckerUnavailableError("The checker session is closed.");
    }
    try {
      const channel = ensureApi();
      const previousHashes = trackedHashesByProject.get(request.tsconfigPath);
      const nextHashes = hashTrackedFiles(request.trackedFiles);
      const changes = computeFileChanges(previousHashes ?? new Map(), nextHashes);
      const current = refreshSnapshot(
        channel,
        request.tsconfigPath,
        previousHashes === undefined,
        changes,
      );
      trackedHashesByProject.set(request.tsconfigPath, nextHashes);
      const project = current.getProject(request.tsconfigPath);
      if (project === undefined) {
        return failUnavailable(`tsgo did not load the project ${request.tsconfigPath}.`);
      }
      return project;
    } catch (error) {
      if (error instanceof CheckerUnavailableError) {
        throw error;
      }
      return failUnavailable("The tsgo checker process failed while updating its snapshot.", error);
    }
  }

  return {
    lease(request) {
      generation += 1;
      let retired = false;
      let project: OpenProject | undefined;
      const query = createTypeQuery({
        generation,
        // 懒 spawn 的接线:门面每次操作先经这两个 thunk 拿 checker/program,首次调用才真正
        // 建进程与 snapshot。
        get checker() {
          project ??= openProject(request);
          return project.checker;
        },
        get program() {
          project ??= openProject(request);
          return project.program;
        },
        // closed 不算 retired:关闭会话后的查询在 openProject 里换成 CheckerUnavailableError,
        // 语义是"环境不可用",不是"程序拿错句柄"。
        isRetired: () => retired,
        onTransportFailure: (error) => {
          if (error instanceof CheckerUnavailableError) {
            throw error;
          }
          return failUnavailable("The tsgo checker process failed while answering a query.", error);
        },
      });
      return {
        query,
        retire() {
          retired = true;
        },
      };
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      try {
        snapshot?.dispose();
        api?.close();
      } catch {
        // close 幂等:子进程已死时的清理失败不再向上冒泡。
      }
      if (api !== undefined) {
        process.off("exit", exitHandler);
      }
      snapshot = undefined;
      api = undefined;
    },
  };
}
