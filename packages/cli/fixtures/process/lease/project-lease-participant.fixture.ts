import { createChildLeaseParticipant } from "#internal/project-lease";

const leaseToken = process.argv[2];
if (!leaseToken) {
  throw new Error("Expected a lease token.");
}

const endpoint = await createChildLeaseParticipant(leaseToken);
process.send?.({ type: "participant", participant: endpoint.participant });

process.on("disconnect", async () => {
  await new Promise((resolve) => setTimeout(resolve, 750));
  await endpoint.close();
  process.exit(0);
});

process.on("message", async (message: unknown) => {
  if (typeof message === "object" && message !== null && Reflect.get(message, "type") === "close") {
    await endpoint.close();
    process.exit(0);
  }
});
