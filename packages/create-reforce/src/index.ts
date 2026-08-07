#!/usr/bin/env node
import { runCreateReforce } from "@/cli";

process.exitCode = await runCreateReforce();
