import { rename } from "node:fs/promises";
import { sleep } from "radashi";
import { errorCode, pathExists } from "@/project/fs-error";

const retryDelays = [10, 20, 40, 80, 160] as const;

type RenameOperation = (source: string, destination: string) => Promise<void>;
type WaitOperation = (milliseconds: number) => Promise<unknown>;
type DestinationExistsOperation = (destination: string) => Promise<boolean>;

interface WindowsRenameRetryOperations {
  readonly rename?: RenameOperation;
  readonly wait?: WaitOperation;
}

interface MissingDestinationPublishOperations extends WindowsRenameRetryOperations {
  readonly destinationExists?: DestinationExistsOperation;
}

// On Windows, antivirus scanners and search indexers briefly hold handles on files and
// directories, so a rename can fail spuriously with EPERM/EBUSY/ENOTEMPTY. These errors are
// retried with the short backoff in retryDelays to ride out the transient lock; any other
// error is a real failure.
function isRetryableWindowsRenameError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) {
    return false;
  }
  return error.code === "EPERM" || error.code === "EBUSY" || error.code === "ENOTEMPTY";
}

// rename publishes a directory only while the destination does not exist: EEXIST/ENOTEMPTY
// means another writer won the atomic claim, which is a collision, not an error. EPERM/EBUSY
// is ambiguous on Windows (transient lock vs. lost race), so the destination is re-checked
// before deciding collision vs. retry.
async function missingDestinationFailureDisposition(
  error: unknown,
  destination: string,
  targetExists: DestinationExistsOperation,
): Promise<"collision" | "retry" | "throw"> {
  const code = errorCode(error);
  if (code === "EEXIST" || code === "ENOTEMPTY") {
    return "collision";
  }
  if (code !== "EPERM" && code !== "EBUSY") {
    return "throw";
  }
  return (await targetExists(destination)) ? "collision" : "retry";
}

export async function renameWithWindowsRetry(
  source: string,
  destination: string,
  operations: WindowsRenameRetryOperations = {},
): Promise<void> {
  const renameOperation = operations.rename ?? rename;
  const wait = operations.wait ?? sleep;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameOperation(source, destination);
      return;
    } catch (error) {
      const retryDelay = retryDelays[attempt];
      if (retryDelay === undefined || !isRetryableWindowsRenameError(error)) {
        throw error;
      }
      await wait(retryDelay);
    }
  }
}

export async function publishMissingDestinationWithWindowsRetry(
  source: string,
  destination: string,
  operations: MissingDestinationPublishOperations = {},
): Promise<boolean> {
  const renameOperation = operations.rename ?? rename;
  const wait = operations.wait ?? sleep;
  const targetExists = operations.destinationExists ?? pathExists;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameOperation(source, destination);
      return true;
    } catch (error) {
      const disposition = await missingDestinationFailureDisposition(
        error,
        destination,
        targetExists,
      );
      if (disposition === "collision") {
        return false;
      }
      if (disposition === "throw") {
        throw error;
      }
      const retryDelay = retryDelays[attempt];
      if (retryDelay === undefined) {
        throw error;
      }
      await wait(retryDelay);
    }
  }
}
