import { isObject } from "radashi";
import type { LeaseParticipant } from "@/project/lease-endpoint";

export const writerLeaseTokenEnvironmentVariable = "REFORCE_WRITER_LEASE_TOKEN";

export interface DevChildLeaseParticipantMessage {
  readonly type: "reforce:lease-participant";
  readonly participant: LeaseParticipant;
}

export interface DevChildLeaseParticipantAcknowledgement {
  readonly type: "reforce:lease-participant-ack";
  readonly participantToken: string;
  readonly ok: boolean;
}

export interface DevChildReadyMessage {
  readonly type: "reforce:dev-ready";
}

// The child cannot discover updates on its own: whether a hot-update manifest exists depends on
// whether the parent has finished compiling, and asking before then leaves the rspack HMR runtime
// permanently stuck in "check" status (Issue #46). The parent is the only side that knows a build
// landed and validated, so it is the side that speaks.
export interface DevBuildReadyMessage {
  readonly type: "reforce:dev-build-ready";
  readonly buildId: string;
}

export interface ShutdownRequestMessage {
  readonly type: "reforce:shutdown";
  readonly requestId: string;
}

// `code` is a write-only breadcrumb: neither the guard below nor any ack reader inspects it, so the
// union exists only to keep the two producers in one type. ShutdownController (runtime/dev-entry.ts,
// production-runtime.ts) reports SHUTDOWN_FAILED because it *is* the process shutting itself down.
// CHILD_FAILED comes only from commands/start.ts, which acks its own parent for a child that already
// exited non-zero — a state no in-process controller can observe (Issue #22).
export interface ShutdownAckMessage {
  readonly type: "reforce:shutdown-ack";
  readonly requestId: string;
  readonly ok: boolean;
  readonly code?: "CHILD_FAILED" | "SHUTDOWN_FAILED";
}

export function isDevChildLeaseParticipantMessage(
  value: unknown,
): value is DevChildLeaseParticipantMessage {
  if (!isObject(value)) {
    return false;
  }
  const participant = Reflect.get(value, "participant");
  return (
    Reflect.get(value, "type") === "reforce:lease-participant" &&
    isObject(participant) &&
    Reflect.get(participant, "role") === "child" &&
    typeof Reflect.get(participant, "participantToken") === "string"
  );
}

export function isDevChildLeaseParticipantAcknowledgement(
  value: unknown,
  participantToken: string,
): value is DevChildLeaseParticipantAcknowledgement {
  return (
    isObject(value) &&
    Reflect.get(value, "type") === "reforce:lease-participant-ack" &&
    Reflect.get(value, "participantToken") === participantToken &&
    typeof Reflect.get(value, "ok") === "boolean"
  );
}

export function isDevChildReadyMessage(value: unknown): value is DevChildReadyMessage {
  return isObject(value) && Reflect.get(value, "type") === "reforce:dev-ready";
}

export function isDevBuildReadyMessage(value: unknown): value is DevBuildReadyMessage {
  if (!isObject(value)) {
    return false;
  }
  return (
    Reflect.get(value, "type") === "reforce:dev-build-ready" &&
    typeof Reflect.get(value, "buildId") === "string"
  );
}

export function isShutdownRequestMessage(value: unknown): value is ShutdownRequestMessage {
  if (!isObject(value)) {
    return false;
  }
  return (
    Reflect.get(value, "type") === "reforce:shutdown" &&
    typeof Reflect.get(value, "requestId") === "string"
  );
}

export function isShutdownAcknowledgementMessage(value: unknown): value is ShutdownAckMessage {
  if (!isObject(value)) {
    return false;
  }
  return (
    Reflect.get(value, "type") === "reforce:shutdown-ack" &&
    typeof Reflect.get(value, "requestId") === "string" &&
    typeof Reflect.get(value, "ok") === "boolean"
  );
}
