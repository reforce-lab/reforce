#!/usr/bin/env bun
import { requireBunExecutable } from "./bun-runtime";
import { PlainTextReporter } from "./reporter";
import { runCli } from "./run-cli";

requireBunExecutable();
const exitCode = await runCli({
  argv: process.argv,
  cwd: process.cwd(),
  reporter: new PlainTextReporter(),
});
process.exitCode = exitCode;
