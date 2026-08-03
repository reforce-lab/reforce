import { writeFile } from "node:fs/promises";
import { createChildLeaseParticipant } from "@/project/lease-endpoint";

const mode = process.argv[2];
const observationPath = process.argv[3];
if ((mode !== "silent" && mode !== "participant") || !observationPath) {
  throw new Error("Invalid development child startup failure harness arguments.");
}

const leaseToken = "harness-writer-token";
const endpoint = await createChildLeaseParticipant(leaseToken);
await writeFile(
  observationPath,
  `${JSON.stringify({ leaseToken, participant: endpoint.participant })}\n`,
  "utf8",
);
if (mode === "participant") {
  process.send?.({ type: "reforce:lease-participant", participant: endpoint.participant });
}
await new Promise<void>(() => undefined);
