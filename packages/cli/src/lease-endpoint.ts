import { randomBytes } from "node:crypto";
import { createConnection, createServer, type Server, type Socket } from "node:net";

export interface LeaseParticipant {
  readonly participantToken: string;
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly challenge: string;
  readonly role: "parent" | "child";
}

export type LeaseProbeResult = "live" | "dead" | "unknown";

function randomToken(): string {
  return randomBytes(32).toString("hex");
}

export class LivenessEndpoint {
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  readonly challenge = randomToken();
  readonly leaseToken: string;
  readonly participantToken = randomToken();
  readonly port: number;
  private closePromise?: Promise<void>;

  private constructor(server: Server, leaseToken: string, port: number) {
    this.server = server;
    this.leaseToken = leaseToken;
    this.port = port;
  }

  static async create(leaseToken: string): Promise<LivenessEndpoint> {
    let endpoint: LivenessEndpoint | undefined;
    const server = createServer((socket) => {
      if (endpoint !== undefined) {
        endpoint.accept(socket);
      }
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
      throw new Error("Liveness endpoint did not publish a TCP port.");
    }
    endpoint = new LivenessEndpoint(server, leaseToken, address.port);
    return endpoint;
  }

  participant(role: LeaseParticipant["role"]): LeaseParticipant {
    return {
      participantToken: this.participantToken,
      host: "127.0.0.1",
      port: this.port,
      challenge: this.challenge,
      role,
    };
  }

  async close(): Promise<void> {
    this.closePromise ??= new Promise<void>((resolve, reject) => {
      for (const socket of this.sockets) {
        socket.destroy();
      }
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    return this.closePromise;
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
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
      socket.end(
        `${JSON.stringify({
          schemaVersion: 1,
          leaseToken: this.leaseToken,
          challenge: this.challenge,
        })}\n`,
      );
    });
    socket.on("close", () => this.sockets.delete(socket));
  }
}

export async function probeLeaseEndpoint(
  input: { readonly host: "127.0.0.1"; readonly port: number; readonly challenge: string },
  expectedLeaseToken: string,
  timeoutMilliseconds: number,
): Promise<LeaseProbeResult> {
  return await new Promise<LeaseProbeResult>((resolve) => {
    const socket = createConnection({ host: input.host, port: input.port });
    let settled = false;
    let response = "";
    const settle = (result: LeaseProbeResult) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMilliseconds);
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ schemaVersion: 1, challenge: input.challenge })}\n`);
    });
    socket.on("data", (chunk: string) => {
      response += chunk;
      if (response.length > 8_192) {
        settle("unknown");
        return;
      }
      const newlineIndex = response.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      try {
        const parsed = JSON.parse(response.slice(0, newlineIndex));
        const matches =
          Reflect.get(parsed, "schemaVersion") === 1 &&
          Reflect.get(parsed, "leaseToken") === expectedLeaseToken &&
          Reflect.get(parsed, "challenge") === input.challenge;
        settle(matches ? "live" : "dead");
      } catch {
        settle("dead");
      }
    });
    socket.once("end", () => settle(response.includes("\n") ? "dead" : "unknown"));
    socket.once("timeout", () => settle("unknown"));
    socket.once("error", (error) => {
      settle("code" in error && error.code === "ECONNREFUSED" ? "dead" : "unknown");
    });
  });
}

export async function createChildLeaseParticipant(leaseToken: string): Promise<{
  readonly participant: LeaseParticipant;
  close(): Promise<void>;
}> {
  const endpoint = await LivenessEndpoint.create(leaseToken);
  return {
    participant: endpoint.participant("child"),
    close: () => endpoint.close(),
  };
}
