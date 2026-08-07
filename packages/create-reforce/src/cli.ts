import { relative, resolve } from "node:path";
import { cancel } from "@clack/prompts";
import { type CliOptions, parseCliOptions, UsageError } from "@/options";
import { readPackageVersion } from "@/package-metadata";
import { scaffoldProject } from "@/project/scaffold";
import { validatePackageName } from "@/project-name";
import { describeUnusableDirectory } from "@/target-directory";
import { type Answers, CancelledError, resolveAnswers } from "@/ui/interaction";
import { HELP_TEXT, reportFailure, reportSuccess } from "@/ui/messages";

export interface RunOptions {
  readonly argv?: readonly string[];
  readonly cwd?: string;
}

async function createProject(answers: Answers, cwd: string): Promise<void> {
  const targetDirectory = resolve(cwd, answers.directory);
  // 两项校验都必须在这里做，不能只留在交互的 validate 回调里：--yes 和非 TTY 根本不走
  // 那条路，缺了这道守门就会拿非法包名写出一个装不上的 package.json。
  const nameProblem = validatePackageName(answers.name);
  if (nameProblem !== undefined) {
    throw new UsageError(nameProblem);
  }
  // 目录可用性交互期已经查过一次，这里是落盘前的复查——两次之间用户可能自己动了目录。
  const problem = describeUnusableDirectory(targetDirectory);
  if (problem !== undefined) {
    throw new UsageError(problem);
  }
  const result = await scaffoldProject(
    targetDirectory,
    { name: answers.name, engine: answers.engine, lint: answers.lint },
    answers.existingFiles,
  );
  reportSuccess(relative(cwd, targetDirectory) || ".", result.files);
}

function handleFailure(error: unknown): 0 | 1 {
  if (error instanceof CancelledError) {
    cancel(error.message);
    return 1;
  }
  if (error instanceof UsageError) {
    reportFailure(error.message);
    return 1;
  }
  // 非预期错误保留原始信息：用户会把它贴进 issue。
  reportFailure(error instanceof Error ? error.message : String(error));
  return 1;
}

export async function runCreateReforce(options: RunOptions = {}): Promise<0 | 1> {
  const argv = options.argv ?? process.argv.slice(2);
  const cwd = options.cwd ?? process.cwd();
  let parsed: CliOptions;
  try {
    parsed = parseCliOptions(argv);
  } catch (error) {
    return handleFailure(error);
  }
  if (parsed.help) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return 0;
  }
  if (parsed.version) {
    process.stdout.write(`${readPackageVersion()}\n`);
    return 0;
  }
  try {
    await createProject(await resolveAnswers(parsed, cwd), cwd);
    return 0;
  } catch (error) {
    return handleFailure(error);
  }
}
