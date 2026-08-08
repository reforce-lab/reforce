import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  captureFailure,
  createFailureEvent,
  type Reporter,
  reportShutdownFailure,
} from "@reforce/runtime/reporter";
import stableStringify from "json-stable-stringify";
import { openApiDocumentOf } from "@/openapi/document";
import { readRouteManifest } from "@/project/route-manifest";

// reforce openapi(#306):读生成的 routes.json,导出 OpenAPI 3.2.0 JSON。产物走 stdout
// (缺省)或 --output 文件,状态与失败走 reporter(stderr)——两个流可分开消费,与 explain
// 同一套纪律。不运行编译器:路由表怎么说,文档就怎么写。

export interface OpenapiCommandOptions {
  readonly cwd: string;
  readonly projectDirectory: string;
  /** --output <file>:相对路径从调用目录解析(与 --project 同一基准)。缺省写 stdout。 */
  readonly outputPath?: string;
  readonly reporter: Reporter;
  /** 注入以便测试捕获 stdout 产出；生产缺省直接写 process.stdout。 */
  readonly writeOutput?: (text: string) => void;
}

// 键序由 stable stringify 定死:同一份 routes.json 在任何机器上得到字节一致的文档,
// diff 与缓存都可依赖。
function renderedDocument(document: Record<string, unknown>): string {
  const rendered = stableStringify(document, { space: 2 });
  if (rendered === undefined) {
    throw new Error("The OpenAPI document is not serializable.");
  }
  return `${rendered}\n`;
}

export async function runOpenapiCommand(options: OpenapiCommandOptions): Promise<0 | 1> {
  const writeOutput = options.writeOutput ?? ((text: string) => void process.stdout.write(text));
  let exitCode: 0 | 1 = 1;
  const primaryFailures: unknown[] = [];
  const shutdownFailures: unknown[] = [];
  try {
    const projectRoot = resolve(options.cwd, options.projectDirectory);
    const { manifest, problem } = await readRouteManifest(projectRoot);
    if (manifest === undefined) {
      options.reporter.report(
        createFailureEvent({
          command: "openapi",
          phase: "project",
          fallbackCode: "ARTIFACT_INVALID",
          message: problem ?? "The generated route table is not readable.",
          cause: undefined,
        }),
      );
    } else {
      const text = renderedDocument(openApiDocumentOf(manifest));
      if (options.outputPath === undefined) {
        writeOutput(text);
      } else {
        await writeFile(resolve(options.cwd, options.outputPath), text, "utf8");
      }
      exitCode = 0;
    }
  } catch (error) {
    primaryFailures.push(error);
    options.reporter.report(
      createFailureEvent({
        command: "openapi",
        phase: "project",
        fallbackCode: "ARTIFACT_INVALID",
        message: "Openapi command failed.",
        cause: error,
      }),
    );
  }

  await captureFailure(() => options.reporter.flush(), shutdownFailures);
  if (shutdownFailures.length > 0) {
    await reportShutdownFailure({
      reporter: options.reporter,
      command: "openapi",
      errors: [...primaryFailures, ...shutdownFailures],
    });
    return 1;
  }
  return exitCode;
}
