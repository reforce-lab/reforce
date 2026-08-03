import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isObject } from "radashi";
import {
  DirectoryTransactions,
  type GeneratedTransactionFile,
} from "@/project/directory-transaction";
import { ProjectLease } from "@/project/lease";
import type { LeaseParticipant } from "@/project/lease-endpoint";

const projectRootArgument = process.argv[2];
const modeArgument = process.argv[3];
if (!projectRootArgument || (modeArgument !== "reader" && modeArgument !== "writer")) {
  throw new Error("Expected a project root and lease mode.");
}
const projectRoot = projectRootArgument;
const mode = modeArgument;

const lease = await ProjectLease.acquire({ projectRoot, mode });
process.send?.({ type: "ready", leaseToken: lease.leaseToken });

function parseParticipant(value: unknown): LeaseParticipant | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const participantToken = Reflect.get(value, "participantToken");
  const host = Reflect.get(value, "host");
  const port = Reflect.get(value, "port");
  const challenge = Reflect.get(value, "challenge");
  const role = Reflect.get(value, "role");
  if (
    typeof participantToken !== "string" ||
    host !== "127.0.0.1" ||
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    typeof challenge !== "string" ||
    role !== "child"
  ) {
    return undefined;
  }
  return { participantToken, host, port, challenge, role };
}

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

async function crashDuringTransaction(message: object): Promise<void> {
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

async function releaseLease(): Promise<void> {
  await lease.release();
  process.send?.({ type: "released" });
  process.exit(0);
}

async function addParticipant(message: object): Promise<void> {
  const participant = parseParticipant(Reflect.get(message, "participant"));
  if (participant === undefined) {
    process.exit(2);
  }
  await lease.addParticipant(participant);
  process.send?.({ type: "participant-added", participantToken: participant.participantToken });
}

const messageHandlers = new Map<string, (message: object) => void | Promise<void>>([
  ["release", releaseLease],
  ["add-participant", addParticipant],
  ["crash", () => process.exit(86)],
  ["parent-crash", () => process.exit(88)],
  [
    "transaction-crash",
    (message) => (mode === "writer" ? crashDuringTransaction(message) : undefined),
  ],
]);

process.on("message", (message: unknown) => {
  if (!isObject(message)) {
    return;
  }
  const type = Reflect.get(message, "type");
  if (typeof type !== "string") {
    return;
  }
  void messageHandlers.get(type)?.(message);
});
