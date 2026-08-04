#!/usr/bin/env bun
import { requireBunExecutable } from "@reforce/runtime/bun-runtime";
import { runCli } from "@/commands/run-cli";

requireBunExecutable();
const exitCode = await runCli();
process.exitCode = exitCode;
