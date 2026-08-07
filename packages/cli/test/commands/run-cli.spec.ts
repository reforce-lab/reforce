import type { CliReporterEvent, Reporter } from "@reforce/runtime/reporter";
import { createTemporaryProject } from "@reforce/tooling-testing";
import { expect, test } from "vitest";
import { runCli } from "@/commands/run-cli";

class FirstFlushFailureReporter implements Reporter {
  readonly events: CliReporterEvent[] = [];
  flushCount = 0;

  report(event: CliReporterEvent): void {
    this.events.push(event);
  }

  async flush(): Promise<void> {
    this.flushCount += 1;
    if (this.flushCount === 1) {
      throw new Error("report output unavailable");
    }
  }
}

class RecordingReporter implements Reporter {
  readonly events: CliReporterEvent[] = [];

  report(event: CliReporterEvent): void {
    this.events.push(event);
  }

  async flush(): Promise<void> {}
}

test("a dev reporter failure remains a dev shutdown failure", async () => {
  const temporary = await createTemporaryProject();
  const reporter = new FirstFlushFailureReporter();
  try {
    const result = await runCli({
      argv: [process.execPath, "reforce", "dev", "--project", "missing"],
      cwd: temporary.projectRoot,
      reporter,
    });

    expect(result).toBe(1);
    expect(
      reporter.events.map((event) => [event.command, "phase" in event ? event.phase : undefined]),
    ).toEqual([
      ["dev", "project"],
      ["dev", "shutdown"],
    ]);
    expect(reporter.flushCount).toBe(2);
  } finally {
    await temporary.cleanup();
  }
});

// —— 渲染模式（RFC 0011 D1，#242）——

test("an unknown --error-format value is an argv usage error, not a silent default", async () => {
  const temporary = await createTemporaryProject();
  const reporter = new RecordingReporter();
  try {
    const result = await runCli({
      argv: [process.execPath, "reforce", "build", "--error-format", "pretty"],
      cwd: temporary.projectRoot,
      reporter,
    });

    expect(result).toBe(1);
    expect(reporter.events[0]).toMatchObject({ kind: "failure", code: "CLI_USAGE_ERROR" });
  } finally {
    await temporary.cleanup();
  }
});

// 子进程的 stdio 是 inherit fd2、父子各自构造 reporter，显式模式只能靠 env 传下去。
test("an explicit --error-format is published to child processes through the environment", async () => {
  const temporary = await createTemporaryProject();
  const reporter = new RecordingReporter();
  const before = process.env.REFORCE_ERROR_FORMAT;
  try {
    await runCli({
      argv: [process.execPath, "reforce", "dev", "--project", "missing", "--error-format", "json"],
      cwd: temporary.projectRoot,
      reporter,
    });

    expect(process.env.REFORCE_ERROR_FORMAT).toBe("json");
  } finally {
    if (before === undefined) {
      delete process.env.REFORCE_ERROR_FORMAT;
    } else {
      process.env.REFORCE_ERROR_FORMAT = before;
    }
    await temporary.cleanup();
  }
});
