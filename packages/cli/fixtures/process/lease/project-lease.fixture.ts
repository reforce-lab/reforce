import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNodeExecutable } from "@reforce/tooling-testing";
import { execa } from "execa";
import {
  DirectoryTransactions,
  type GeneratedTransactionFile,
} from "#internal/directory-transaction";
import { ProjectLease } from "#internal/project-lease";

const projectRoot = process.argv[2];
const mode = process.argv[3];
const participantMode = process.argv[4];
const nodeExecutable = await resolveNodeExecutable();

if (!projectRoot || (mode !== "reader" && mode !== "writer")) {
  throw new Error("Expected a project root and lease mode.");
}

const lease = await ProjectLease.acquire({ projectRoot, mode });
if (participantMode === "with-child") {
  const participantFixture = fileURLToPath(
    new URL("./project-lease-participant.fixture.ts", import.meta.url),
  );
  const child = execa(
    nodeExecutable,
    ["--conditions=development", participantFixture, lease.leaseToken],
    {
      cleanup: false,
      ipc: true,
      reject: false,
      shell: false,
      stderr: "ignore",
      stdout: "ignore",
    },
  );
  const message = await child.getOneMessage();
  const participant =
    typeof message === "object" && message !== null
      ? Reflect.get(message, "participant")
      : undefined;
  if (typeof participant !== "object" || participant === null) {
    child.kill();
    await child;
    throw new Error("Child participant sent an invalid endpoint record.");
  }
  await lease.addParticipant({
    participantToken: String(Reflect.get(participant, "participantToken")),
    host: "127.0.0.1",
    port: Number(Reflect.get(participant, "port")),
    challenge: String(Reflect.get(participant, "challenge")),
    role: "child",
  });
  child.nodeChildProcess.unref();
}
process.send?.({ type: "ready", leaseToken: lease.leaseToken });

function generatedFiles(generation: string): readonly GeneratedTransactionFile[] {
  return [
    { path: "beans.ts", content: `export const generation = ${JSON.stringify(generation)};\n` },
    { path: "bootstrap.ts", content: "export async function bootstrap() {}\n" },
    {
      path: "manifest.json",
      content: `${JSON.stringify({
        schemaVersion: 1,
        beans: [],
        plans: {
          constructionOrder: [],
          startActionOrder: [],
          cleanupActionOrder: [],
        },
      })}\n`,
    },
    { path: "qualifiers.d.ts", content: "export {};\n" },
  ];
}

process.on("message", async (message: unknown) => {
  if (typeof message !== "object" || message === null) {
    return;
  }
  if (Reflect.get(message, "type") === "release") {
    await lease.release();
    process.send?.({ type: "released" });
    process.exit(0);
  }
  if (Reflect.get(message, "type") === "crash") {
    process.exit(86);
  }
  if (Reflect.get(message, "type") === "parent-crash") {
    process.exit(88);
  }
  if (Reflect.get(message, "type") === "transaction-crash" && mode === "writer") {
    const faultPoint = Reflect.get(message, "faultPoint");
    const faultIndex = Reflect.get(message, "faultIndex");
    const transactionKind = Reflect.get(message, "transactionKind");
    if (
      typeof faultPoint !== "string" &&
      (typeof faultIndex !== "number" || !Number.isInteger(faultIndex))
    ) {
      process.exit(2);
    }
    let currentFaultIndex = 0;
    const transactions = await DirectoryTransactions.create({
      projectRoot,
      lease,
      faultInjector(point) {
        const shouldCrash =
          typeof faultPoint === "string" ? point === faultPoint : currentFaultIndex === faultIndex;
        currentFaultIndex += 1;
        if (shouldCrash) {
          process.exit(87);
        }
      },
    });
    if (transactionKind === "dist") {
      const prepared = await transactions.prepareDist();
      await mkdir(join(prepared.stagingDirectory, "chunks"));
      await writeFile(
        join(prepared.stagingDirectory, "main.mjs"),
        'await import("./chunks/post.mjs");\n',
      );
      await writeFile(join(prepared.stagingDirectory, "chunks", "post.mjs"), "export {};\n");
      await transactions.commitDist({
        ...prepared,
        expectedFiles: ["chunks/post.mjs", "main.mjs"],
      });
    } else {
      await transactions.commitGenerated(generatedFiles("post"));
    }
    process.exit(3);
  }
});
