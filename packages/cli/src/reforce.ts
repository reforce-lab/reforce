#!/usr/bin/env node
import { PlainTextReporter } from "#internal/reporter";
import { runCli } from "#internal/run-cli";

const exitCode = await runCli({
  argv: process.argv,
  cwd: process.cwd(),
  reporter: new PlainTextReporter(),
});
process.exitCode = exitCode;
