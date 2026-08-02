import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, readdir, readFile, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { isObject, sleep } from "radashi";
import { compareUtf16CodeUnits } from "./determinism";
import {
  type LeaseParticipant,
  type LeaseProbeResult,
  LivenessEndpoint,
  probeLeaseEndpoint,
} from "./lease-endpoint";
import {
  publishMissingDestinationWithWindowsRetry,
  renameWithWindowsRetry,
} from "./windows-rename-retry";

export { createChildLeaseParticipant, type LeaseParticipant } from "./lease-endpoint";

export type ProjectLeaseMode = "writer" | "reader";

export interface LeaseOwnerRecord {
  readonly schemaVersion: 1;
  readonly mode: ProjectLeaseMode;
  readonly leaseToken: string;
  readonly participants: readonly LeaseParticipant[];
  readonly pid?: number;
}

export interface AcquireProjectLeaseOptions {
  readonly projectRoot: string;
  readonly mode: ProjectLeaseMode;
  readonly probeTimeoutMilliseconds?: number;
  readonly gateWaitMilliseconds?: number;
}

interface GateRecord {
  readonly schemaVersion: 1;
  readonly gateToken: string;
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly challenge: string;
}

function randomToken(): string {
  return randomBytes(32).toString("hex");
}

function assertContained(root: string, target: string): void {
  const pathFromRoot = relative(root, target);
  if (
    pathFromRoot !== "" &&
    !isAbsolute(pathFromRoot) &&
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`)
  ) {
    return;
  }
  throw new Error(`Lease path is outside its required boundary: ${target}`);
}

async function safeRemoveDirectory(target: string, boundary: string): Promise<void> {
  try {
    const [canonicalBoundary, canonicalTarget, targetStats] = await Promise.all([
      realpath(boundary),
      realpath(target),
      lstat(target),
    ]);
    assertContained(canonicalBoundary, canonicalTarget);
    if (!targetStats.isDirectory()) {
      throw new Error(`Lease cleanup target is not a directory: ${target}`);
    }
    await rm(target, { recursive: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function writeJsonClosed(path: string, value: unknown): Promise<void> {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function hasExactObjectKeys(
  value: object,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value).sort(compareUtf16CodeUnits);
  const allowed = [...required, ...optional].sort(compareUtf16CodeUnits);
  return (
    required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.includes(key))
  );
}

function parseParticipant(value: unknown): LeaseParticipant | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  if (!hasExactObjectKeys(value, ["participantToken", "host", "port", "challenge", "role"])) {
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
    port < 1 ||
    port > 65_535 ||
    typeof challenge !== "string" ||
    (role !== "parent" && role !== "child")
  ) {
    return undefined;
  }
  return { participantToken, host, port, challenge, role };
}

function parseOwnerRecord(value: unknown): LeaseOwnerRecord | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  if (
    !hasExactObjectKeys(value, ["schemaVersion", "mode", "leaseToken", "participants"], ["pid"])
  ) {
    return undefined;
  }
  const schemaVersion = Reflect.get(value, "schemaVersion");
  const mode = Reflect.get(value, "mode");
  const leaseToken = Reflect.get(value, "leaseToken");
  const participantsValue = Reflect.get(value, "participants");
  const pid = Reflect.get(value, "pid");
  if (
    schemaVersion !== 1 ||
    (mode !== "writer" && mode !== "reader") ||
    typeof leaseToken !== "string" ||
    !Array.isArray(participantsValue) ||
    participantsValue.length === 0 ||
    (pid !== undefined && (typeof pid !== "number" || !Number.isInteger(pid)))
  ) {
    return undefined;
  }
  const participants = participantsValue.map(parseParticipant);
  if (participants.some((participant) => participant === undefined)) {
    return undefined;
  }
  return {
    schemaVersion,
    mode,
    leaseToken,
    participants: participants.filter((participant) => participant !== undefined),
    ...(pid === undefined ? {} : { pid }),
  };
}

function parseGateRecord(value: unknown): GateRecord | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  if (!hasExactObjectKeys(value, ["schemaVersion", "gateToken", "host", "port", "challenge"])) {
    return undefined;
  }
  const schemaVersion = Reflect.get(value, "schemaVersion");
  const gateToken = Reflect.get(value, "gateToken");
  const host = Reflect.get(value, "host");
  const port = Reflect.get(value, "port");
  const challenge = Reflect.get(value, "challenge");
  if (
    schemaVersion !== 1 ||
    typeof gateToken !== "string" ||
    host !== "127.0.0.1" ||
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    typeof challenge !== "string"
  ) {
    return undefined;
  }
  return { schemaVersion, gateToken, host, port, challenge };
}

async function readJson(
  path: string,
): Promise<{ readonly raw: string; readonly value: unknown } | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    return { raw, value: JSON.parse(raw) };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    if (error instanceof SyntaxError) {
      return { raw: "", value: undefined };
    }
    throw error;
  }
}

async function probeOwner(
  record: LeaseOwnerRecord,
  timeoutMilliseconds: number,
): Promise<LeaseProbeResult> {
  const results = await Promise.all(
    record.participants.map((participant) =>
      probeLeaseEndpoint(participant, record.leaseToken, timeoutMilliseconds),
    ),
  );
  if (results.includes("live")) {
    return "live";
  }
  return results.includes("unknown") ? "unknown" : "dead";
}

export class ProjectBusyError extends Error {
  readonly code = "PROJECT_BUSY" as const;

  constructor(projectRoot: string) {
    super(`Project is already in use: ${projectRoot}`);
    this.name = "ProjectBusyError";
  }
}

interface LeasePaths {
  readonly projectRoot: string;
  readonly reforceRoot: string;
  readonly leaseRoot: string;
  readonly quarantineRoot: string;
  readonly readersRoot: string;
  readonly writerRoot: string;
  readonly gateRoot: string;
}

async function prepareLeasePaths(projectRoot: string): Promise<LeasePaths> {
  const canonicalProjectRoot = await realpath(projectRoot);
  const projectStats = await lstat(canonicalProjectRoot);
  if (!projectStats.isDirectory()) {
    throw new Error(`Project root is not a directory: ${projectRoot}`);
  }
  const reforceRoot = join(canonicalProjectRoot, ".reforce");
  await mkdir(reforceRoot, { recursive: true });
  const canonicalReforceRoot = await realpath(reforceRoot);
  assertContained(canonicalProjectRoot, canonicalReforceRoot);
  const leaseRoot = join(canonicalReforceRoot, "lease");
  const quarantineRoot = join(leaseRoot, "quarantine");
  const readersRoot = join(leaseRoot, "readers");
  await mkdir(quarantineRoot, { recursive: true });
  await mkdir(readersRoot, { recursive: true });
  const canonicalLeaseRoot = await realpath(leaseRoot);
  const canonicalQuarantineRoot = await realpath(quarantineRoot);
  const canonicalReadersRoot = await realpath(readersRoot);
  assertContained(canonicalReforceRoot, canonicalLeaseRoot);
  assertContained(canonicalLeaseRoot, canonicalQuarantineRoot);
  assertContained(canonicalLeaseRoot, canonicalReadersRoot);
  return {
    projectRoot: canonicalProjectRoot,
    reforceRoot: canonicalReforceRoot,
    leaseRoot: canonicalLeaseRoot,
    quarantineRoot: canonicalQuarantineRoot,
    readersRoot: canonicalReadersRoot,
    writerRoot: join(canonicalLeaseRoot, "writer"),
    gateRoot: join(canonicalLeaseRoot, "gate"),
  };
}

async function quarantineDirectory(
  paths: LeasePaths,
  source: string,
  label: string,
): Promise<void> {
  const destination = join(paths.quarantineRoot, `${label}-${randomUUID()}`);
  await renameWithWindowsRetry(source, destination);
  await safeRemoveDirectory(destination, paths.quarantineRoot);
}

async function tryPublishGate(staging: string, gateRoot: string): Promise<boolean> {
  return await publishMissingDestinationWithWindowsRetry(staging, gateRoot);
}

async function inspectExistingGate(
  paths: LeasePaths,
  probeTimeoutMilliseconds: number,
  deadline: number,
): Promise<void> {
  const gateSnapshot = await readJson(join(paths.gateRoot, "record.json"));
  const gateRecord = parseGateRecord(gateSnapshot?.value);
  if (!gateSnapshot || !gateRecord) {
    throw new ProjectBusyError(paths.projectRoot);
  }
  const status = await probeLeaseEndpoint(
    gateRecord,
    gateRecord.gateToken,
    probeTimeoutMilliseconds,
  );
  if (status === "unknown" || (status === "live" && Date.now() >= deadline)) {
    throw new ProjectBusyError(paths.projectRoot);
  }
  if (status === "live") {
    await sleep(10);
    return;
  }
  const current = await readJson(join(paths.gateRoot, "record.json"));
  if (current?.raw === gateSnapshot.raw) {
    await quarantineDirectory(paths, paths.gateRoot, `gate-${gateRecord.gateToken}`);
  }
}

async function releaseAcquisitionGate(
  paths: LeasePaths,
  gateToken: string,
  staging: string,
  ownsGate: boolean,
): Promise<void> {
  if (!ownsGate) {
    await safeRemoveDirectory(staging, paths.leaseRoot);
    return;
  }
  const current = await readJson(join(paths.gateRoot, "record.json"));
  const currentRecord = parseGateRecord(current?.value);
  if (currentRecord?.gateToken === gateToken) {
    await quarantineDirectory(paths, paths.gateRoot, `gate-${gateToken}`);
  }
}

async function withAcquisitionGate<T>(
  paths: LeasePaths,
  probeTimeoutMilliseconds: number,
  gateWaitMilliseconds: number,
  operation: () => Promise<T>,
): Promise<T> {
  const gateToken = randomToken();
  const endpoint = await LivenessEndpoint.create(gateToken);
  const staging = join(paths.leaseRoot, `.gate-${gateToken}`);
  const deadline = Date.now() + gateWaitMilliseconds;
  await mkdir(staging);
  await writeJsonClosed(join(staging, "record.json"), {
    schemaVersion: 1,
    gateToken,
    host: "127.0.0.1",
    port: endpoint.port,
    challenge: endpoint.challenge,
  } satisfies GateRecord);

  let ownsGate = false;
  try {
    while (!ownsGate) {
      ownsGate = await tryPublishGate(staging, paths.gateRoot);
      if (!ownsGate) {
        await inspectExistingGate(paths, probeTimeoutMilliseconds, deadline);
      }
    }

    return await operation();
  } finally {
    await releaseAcquisitionGate(paths, gateToken, staging, ownsGate);
    await endpoint.close();
  }
}

interface OwnerSnapshot {
  readonly directory: string;
  readonly raw: string;
  readonly record: LeaseOwnerRecord;
}

async function readOwner(
  directory: string,
  projectRoot: string,
): Promise<OwnerSnapshot | undefined> {
  const snapshot = await readJson(join(directory, "record.json"));
  if (!snapshot) {
    return undefined;
  }
  const record = parseOwnerRecord(snapshot.value);
  if (!record) {
    throw new ProjectBusyError(projectRoot);
  }
  return { directory, raw: snapshot.raw, record };
}

async function listReaderOwners(paths: LeasePaths): Promise<readonly OwnerSnapshot[]> {
  const entries = await readdir(paths.readersRoot, { withFileTypes: true });
  entries.sort((left, right) => compareUtf16CodeUnits(left.name, right.name));
  const readers: OwnerSnapshot[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      throw new Error(`Invalid reader lease entry: ${entry.name}`);
    }
    const reader = await readOwner(join(paths.readersRoot, entry.name), paths.projectRoot);
    if (reader) {
      readers.push(reader);
    }
  }
  return readers;
}

async function isolateDeadOwner(paths: LeasePaths, snapshot: OwnerSnapshot): Promise<void> {
  const current = await readOwner(snapshot.directory, paths.projectRoot);
  if (!current || current.raw !== snapshot.raw) {
    throw new ProjectBusyError(paths.projectRoot);
  }
  await quarantineDirectory(
    paths,
    snapshot.directory,
    `${snapshot.record.mode}-${snapshot.record.leaseToken}`,
  );
}

async function atomicReplaceOwnerRecord(
  directory: string,
  record: LeaseOwnerRecord,
): Promise<void> {
  const temporaryPath = join(directory, `record-${randomUUID()}.json`);
  await writeJsonClosed(temporaryPath, record);
  await renameWithWindowsRetry(temporaryPath, join(directory, "record.json"));
}

async function conflictingOwners(
  paths: LeasePaths,
  mode: ProjectLeaseMode,
): Promise<{
  readonly writer?: OwnerSnapshot;
  readonly owners: readonly OwnerSnapshot[];
}> {
  const writer = await readOwner(paths.writerRoot, paths.projectRoot);
  const owners: OwnerSnapshot[] = [];
  if (writer) {
    owners.push(writer);
  }
  if (mode === "writer") {
    owners.push(...(await listReaderOwners(paths)));
  }
  return { ...(writer ? { writer } : {}), owners };
}

async function recoverConflictingOwners(
  paths: LeasePaths,
  mode: ProjectLeaseMode,
  conflicts: {
    readonly writer?: OwnerSnapshot;
    readonly owners: readonly OwnerSnapshot[];
  },
  probeTimeoutMilliseconds: number,
): Promise<readonly string[]> {
  const statuses = await Promise.all(
    conflicts.owners.map((conflict) => probeOwner(conflict.record, probeTimeoutMilliseconds)),
  );
  if (statuses.some((status) => status !== "dead")) {
    throw new ProjectBusyError(paths.projectRoot);
  }
  if (mode === "reader" && conflicts.writer) {
    throw new ProjectBusyError(paths.projectRoot);
  }

  const recovered: string[] = [];
  for (const conflict of conflicts.owners) {
    await isolateDeadOwner(paths, conflict);
    if (mode === "writer" && conflict.record.mode === "writer") {
      recovered.push(conflict.record.leaseToken);
    }
  }
  return [...new Set(recovered)].sort(compareUtf16CodeUnits);
}

async function publishOwnerRecord(paths: LeasePaths, record: LeaseOwnerRecord): Promise<void> {
  const staging = join(paths.leaseRoot, `.owner-${record.leaseToken}`);
  const destination =
    record.mode === "writer" ? paths.writerRoot : join(paths.readersRoot, record.leaseToken);
  await mkdir(staging);
  await writeJsonClosed(join(staging, "record.json"), record);
  await renameWithWindowsRetry(staging, destination);
}

export class ProjectLease {
  readonly mode: ProjectLeaseMode;
  readonly projectRoot: string;
  readonly leaseToken: string;
  readonly recoveredWriterTokens: readonly string[];
  readonly #endpoint: LivenessEndpoint;
  readonly #paths: LeasePaths;
  readonly #probeTimeoutMilliseconds: number;
  readonly #gateWaitMilliseconds: number;
  readonly #recoverableWriterTokens: Set<string>;
  #releasePromise?: Promise<void>;

  private constructor(input: {
    readonly mode: ProjectLeaseMode;
    readonly paths: LeasePaths;
    readonly leaseToken: string;
    readonly endpoint: LivenessEndpoint;
    readonly recoveredWriterTokens: readonly string[];
    readonly probeTimeoutMilliseconds: number;
    readonly gateWaitMilliseconds: number;
  }) {
    this.mode = input.mode;
    this.projectRoot = input.paths.projectRoot;
    this.leaseToken = input.leaseToken;
    this.#paths = input.paths;
    this.#endpoint = input.endpoint;
    this.recoveredWriterTokens = Object.freeze([...input.recoveredWriterTokens]);
    this.#recoverableWriterTokens = new Set(input.recoveredWriterTokens);
    this.#probeTimeoutMilliseconds = input.probeTimeoutMilliseconds;
    this.#gateWaitMilliseconds = input.gateWaitMilliseconds;
  }

  static async acquire(options: AcquireProjectLeaseOptions): Promise<ProjectLease> {
    const probeTimeoutMilliseconds = options.probeTimeoutMilliseconds ?? 500;
    const gateWaitMilliseconds = options.gateWaitMilliseconds ?? 5_000;
    const paths = await prepareLeasePaths(options.projectRoot);
    const leaseToken = randomToken();
    const endpoint = await LivenessEndpoint.create(leaseToken);
    const ownRecord: LeaseOwnerRecord = {
      schemaVersion: 1,
      mode: options.mode,
      leaseToken,
      participants: [endpoint.participant("parent")],
      pid: process.pid,
    };

    try {
      const recoveredWriterTokens = await withAcquisitionGate(
        paths,
        probeTimeoutMilliseconds,
        gateWaitMilliseconds,
        async () => {
          const recovered = await recoverConflictingOwners(
            paths,
            options.mode,
            await conflictingOwners(paths, options.mode),
            probeTimeoutMilliseconds,
          );
          await publishOwnerRecord(paths, ownRecord);
          return recovered;
        },
      );

      return new ProjectLease({
        mode: options.mode,
        paths,
        leaseToken,
        endpoint,
        recoveredWriterTokens,
        probeTimeoutMilliseconds,
        gateWaitMilliseconds,
      });
    } catch (error) {
      await endpoint.close();
      throw error;
    }
  }

  async addParticipant(participant: LeaseParticipant): Promise<void> {
    const validatedParticipant = parseParticipant(participant);
    if (validatedParticipant?.role !== "child") {
      throw new ProjectBusyError(this.projectRoot);
    }
    const status = await probeLeaseEndpoint(
      validatedParticipant,
      this.leaseToken,
      this.#probeTimeoutMilliseconds,
    );
    if (status !== "live") {
      throw new ProjectBusyError(this.projectRoot);
    }
    await this.#updateParticipants((participants) => {
      if (
        participants.some(
          (candidate) => candidate.participantToken === validatedParticipant.participantToken,
        )
      ) {
        return participants;
      }
      return [...participants, validatedParticipant];
    });
  }

  async removeParticipant(participantToken: string): Promise<void> {
    if (participantToken === this.#endpoint.participantToken) {
      throw new Error("The parent participant remains registered for the lease lifetime.");
    }
    await this.#updateParticipants((participants) =>
      participants.filter((participant) => participant.participantToken !== participantToken),
    );
  }

  async assertCurrentWriter(): Promise<void> {
    if (this.mode !== "writer") {
      throw new Error("A reader lease cannot publish a transaction.");
    }
    const current = await readOwner(this.#paths.writerRoot, this.projectRoot);
    if (current?.record.leaseToken !== this.leaseToken) {
      throw new ProjectBusyError(this.projectRoot);
    }
  }

  canRecoverWriterToken(token: string): boolean {
    return this.#recoverableWriterTokens.has(token);
  }

  consumeRecoveredWriterToken(token: string): void {
    if (!this.#recoverableWriterTokens.delete(token)) {
      throw new ProjectBusyError(this.projectRoot);
    }
  }

  release(): Promise<void> {
    this.#releasePromise ??= this.#release();
    return this.#releasePromise;
  }

  async #release(): Promise<void> {
    await this.#endpoint.close();
    await withAcquisitionGate(
      this.#paths,
      this.#probeTimeoutMilliseconds,
      this.#gateWaitMilliseconds,
      async () => {
        const directory =
          this.mode === "writer"
            ? this.#paths.writerRoot
            : join(this.#paths.readersRoot, this.leaseToken);
        const current = await readOwner(directory, this.projectRoot);
        if (current?.record.leaseToken === this.leaseToken) {
          const childParticipants = current.record.participants.filter(
            (participant) => participant.participantToken !== this.#endpoint.participantToken,
          );
          const childStatuses = await Promise.all(
            childParticipants.map((participant) =>
              probeLeaseEndpoint(participant, this.leaseToken, this.#probeTimeoutMilliseconds),
            ),
          );
          if (childStatuses.some((status) => status !== "dead")) {
            throw new ProjectBusyError(this.projectRoot);
          }
          await quarantineDirectory(this.#paths, directory, `${this.mode}-${this.leaseToken}`);
        }
      },
    );
  }

  async #updateParticipants(
    update: (participants: readonly LeaseParticipant[]) => readonly LeaseParticipant[],
  ): Promise<void> {
    await withAcquisitionGate(
      this.#paths,
      this.#probeTimeoutMilliseconds,
      this.#gateWaitMilliseconds,
      async () => {
        const directory =
          this.mode === "writer"
            ? this.#paths.writerRoot
            : join(this.#paths.readersRoot, this.leaseToken);
        const current = await readOwner(directory, this.projectRoot);
        if (current?.record.leaseToken !== this.leaseToken) {
          throw new ProjectBusyError(this.projectRoot);
        }
        const participants = update(current.record.participants);
        if (participants.length === 0) {
          throw new Error("A live lease must retain at least one participant.");
        }
        await atomicReplaceOwnerRecord(directory, {
          ...current.record,
          participants,
        });
      },
    );
  }
}

export async function leaseRecordExists(
  projectRoot: string,
  mode: ProjectLeaseMode,
  leaseToken?: string,
): Promise<boolean> {
  const paths = await prepareLeasePaths(projectRoot);
  const target = mode === "writer" ? paths.writerRoot : join(paths.readersRoot, leaseToken ?? "");
  try {
    await access(join(target, "record.json"), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
