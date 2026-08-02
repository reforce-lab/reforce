import { createChildLeaseParticipant } from "../../../src/project-lease";

const leaseToken = process.argv[2];
if (!leaseToken) {
  throw new Error("Expected a lease token.");
}

const endpoint = await createChildLeaseParticipant(leaseToken);
process.send?.({ type: "participant", participant: endpoint.participant });

const finishClose = Promise.withResolvers<void>();
let closePromise: Promise<void> | undefined;

function closeEndpoint(): Promise<void> {
  closePromise ??= endpoint.close().then(() => process.exit(0));
  return closePromise;
}

process.on("disconnect", () => {
  finishClose.resolve();
  void closeEndpoint();
});

process.on("message", (message: unknown) => {
  if (typeof message !== "object" || message === null) {
    return;
  }
  const type = Reflect.get(message, "type");
  if (type === "close") {
    void closeEndpoint();
    return;
  }
  if (type === "begin-close") {
    process.send?.({ type: "closing" });
    closePromise ??= finishClose.promise.then(() => endpoint.close()).then(() => process.exit(0));
    return;
  }
  if (type === "finish-close") {
    finishClose.resolve();
  }
});
