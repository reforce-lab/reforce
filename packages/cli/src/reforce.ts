#!/usr/bin/env node
import { requireNodeExecutable } from "@reforce/runtime/node-runtime";
import { runCli } from "@/commands/run-cli";

requireNodeExecutable();
const exitCode = await runCli();
process.exitCode = exitCode;
