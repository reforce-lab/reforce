import { isObject } from "radashi";
import type { LeaseParticipant } from "@/lease-endpoint";

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

export interface ShutdownRequestMessage {
  readonly type: "reforce:shutdown";
  readonly requestId: string;
}

export interface ShutdownAckMessage {
  readonly type: "reforce:shutdown-ack";
  readonly requestId: string;
  readonly ok: boolean;
  readonly code?: "SHUTDOWN_FAILED";
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
