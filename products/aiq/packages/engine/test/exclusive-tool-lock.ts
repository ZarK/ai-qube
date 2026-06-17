import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const lockRoot = path.join(os.tmpdir(), "aiq-test-locks");
const defaultPollIntervalMs = 100;
const defaultStaleLockMs = 45_000;
const defaultWaitTimeoutMs = 90_000;

type ExclusiveToolLockOptions = {
  pollIntervalMs?: number;
  staleLockMs?: number;
  waitTimeoutMs?: number;
};

type LockMetadata = {
  acquiredAt: number;
  pid: number;
};

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

async function readLockMetadata(lockPath: string): Promise<LockMetadata | null> {
  try {
    const metadata = JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8")) as {
      acquiredAt?: number;
      pid?: number;
    };

    if (typeof metadata.acquiredAt !== "number" || typeof metadata.pid !== "number") {
      return null;
    }

    return {
      acquiredAt: metadata.acquiredAt,
      pid: metadata.pid,
    };
  } catch (error) {
    if (isMissingFileError(error) || error instanceof SyntaxError) {
      return null;
    }

    throw error;
  }
}

async function writeLockMetadata(lockPath: string): Promise<void> {
  await writeFile(
    path.join(lockPath, "owner.json"),
    `${JSON.stringify({ acquiredAt: Date.now(), pid: process.pid })}\n`,
    "utf8",
  );
}

async function isStaleLock(lockPath: string, staleLockMs: number): Promise<boolean> {
  const metadata = await readLockMetadata(lockPath);
  if (metadata !== null) {
    return !isProcessRunning(metadata.pid);
  }

  try {
    const lockStats = await stat(lockPath);
    return Date.now() - lockStats.mtimeMs >= staleLockMs;
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }

    throw error;
  }
}

async function tryAcquireRecoveryGuard(
  recoveryPath: string,
  staleLockMs: number,
): Promise<boolean> {
  while (true) {
    try {
      await mkdir(recoveryPath);
      try {
        await writeLockMetadata(recoveryPath);
      } catch (error) {
        await rm(recoveryPath, { force: true, recursive: true });
        throw error;
      }

      return true;
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }

      const metadata = await readLockMetadata(recoveryPath);
      if (metadata !== null && !isProcessRunning(metadata.pid)) {
        await rm(recoveryPath, { force: true, recursive: true });
        continue;
      }

      if (metadata === null && (await isStaleLock(recoveryPath, staleLockMs))) {
        await rm(recoveryPath, { force: true, recursive: true });
        continue;
      }

      return false;
    }
  }
}

async function tryRecoverStaleLock(lockPath: string, staleLockMs: number): Promise<boolean> {
  if (!(await isStaleLock(lockPath, staleLockMs))) {
    return false;
  }

  const recoveryPath = `${lockPath}.recovery`;
  if (!(await tryAcquireRecoveryGuard(recoveryPath, staleLockMs))) {
    return false;
  }

  try {
    if (!(await isStaleLock(lockPath, staleLockMs))) {
      return false;
    }

    await rm(lockPath, { force: true, recursive: true });
    return true;
  } finally {
    await rm(recoveryPath, { force: true, recursive: true });
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function withExclusiveToolLock<T>(
  toolName: string,
  run: () => Promise<T>,
  options: ExclusiveToolLockOptions = {},
): Promise<T> {
  await mkdir(lockRoot, { recursive: true });

  const lockPath = path.join(lockRoot, `${toolName}.lock`);
  const pollIntervalMs = options.pollIntervalMs ?? defaultPollIntervalMs;
  const staleLockMs = options.staleLockMs ?? defaultStaleLockMs;
  const waitTimeoutMs = options.waitTimeoutMs ?? defaultWaitTimeoutMs;
  const deadline = Date.now() + waitTimeoutMs;

  while (true) {
    try {
      await mkdir(lockPath);
      try {
        await writeLockMetadata(lockPath);
      } catch (error) {
        await rm(lockPath, { force: true, recursive: true });
        throw error;
      }

      break;
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }

      if (await tryRecoverStaleLock(lockPath, staleLockMs)) {
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for the ${toolName} test lock after ${waitTimeoutMs}ms.`,
        );
      }

      await sleep(pollIntervalMs);
    }
  }

  try {
    return await run();
  } finally {
    await rm(lockPath, { force: true, recursive: true });
  }
}
