import { execa, type Options, type Result, type ResultPromise } from "execa";

export interface CommandOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly input?: string | Uint8Array;
  readonly timeout?: number;
}

function toExecaOptions(options: CommandOptions): Options {
  return {
    cleanup: true,
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    reject: false,
    shell: false,
    timeout: options.timeout,
  };
}

export function spawnCommand(
  file: string,
  arguments_: readonly string[],
  options: CommandOptions = {},
): ResultPromise {
  return execa(file, [...arguments_], toExecaOptions(options));
}

export async function runCommand(
  file: string,
  arguments_: readonly string[],
  options: CommandOptions = {},
): Promise<Result> {
  return await spawnCommand(file, arguments_, options);
}
