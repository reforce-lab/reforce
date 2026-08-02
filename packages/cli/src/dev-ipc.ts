import { isObject } from "radashi";
import type { LeaseParticipant } from "#internal/project-lease";

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
