import { randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import type { LeaseParticipant } from "#internal/project-lease";

function randomToken(): string {
  return randomBytes(32).toString("hex");
}

export interface DevChildLeaseEndpoint {
  readonly participant: LeaseParticipant;
  close(): Promise<void>;
}

export async function createDevChildLeaseEndpoint(
  leaseToken: string,
): Promise<DevChildLeaseEndpoint> {
  const challenge = randomToken();
  const participantToken = randomToken();
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    let request = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      request += chunk;
      if (request.length > 8_192) {
        socket.destroy();
        return;
      }
      const newlineIndex = request.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      try {
        JSON.parse(request.slice(0, newlineIndex));
      } catch {
        socket.end("{}\n");
        return;
      }
      socket.end(`${JSON.stringify({ schemaVersion: 1, leaseToken, challenge })}\n`);
    });
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Development child liveness endpoint did not publish a TCP port.");
  }
  let closePromise: Promise<void> | undefined;
  return {
    participant: {
      participantToken,
      host: "127.0.0.1",
      port: address.port,
      challenge,
      role: "child",
    },
    close() {
      closePromise ??= new Promise<void>((resolve, reject) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      return closePromise;
    },
  };
}
