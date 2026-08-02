import { expect, test } from "bun:test";
import { createTemporaryProject } from "@reforce/tooling-testing";
import type { CliReporterEvent, Reporter } from "@/reporter";
import { runCli } from "@/run-cli";

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
