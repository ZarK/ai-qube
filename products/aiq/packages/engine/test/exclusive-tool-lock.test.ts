import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { withExclusiveToolLock } from "./exclusive-tool-lock.js";

const lockRoot = path.join(os.tmpdir(), "aiq-test-locks");

async function cleanupLock(toolName: string): Promise<void> {
  await rm(path.join(lockRoot, `${toolName}.lock`), { force: true, recursive: true });
}

async function cleanupRecoveryLock(toolName: string): Promise<void> {
  await rm(path.join(lockRoot, `${toolName}.lock.recovery`), { force: true, recursive: true });
}

describe("exclusive tool lock", () => {
  afterEach(async () => {
    await cleanupLock("exclusive-tool-lock-race");
    await cleanupLock("exclusive-tool-lock-release");
    await cleanupLock("exclusive-tool-lock-live-owner");
    await cleanupLock("exclusive-tool-lock-stale");
    await cleanupLock("exclusive-tool-lock-stale-recovery");
    await cleanupRecoveryLock("exclusive-tool-lock-race");
    await cleanupRecoveryLock("exclusive-tool-lock-release");
    await cleanupRecoveryLock("exclusive-tool-lock-live-owner");
    await cleanupRecoveryLock("exclusive-tool-lock-stale");
    await cleanupRecoveryLock("exclusive-tool-lock-stale-recovery");
  });

  it("releases the lock when the wrapped callback rejects", async () => {
    await expect(
      withExclusiveToolLock("exclusive-tool-lock-release", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await expect(
      withExclusiveToolLock("exclusive-tool-lock-release", async () => "reacquired"),
    ).resolves.toBe("reacquired");
  });

  it("recovers stale locks left behind by dead owners", async () => {
    const lockPath = path.join(lockRoot, "exclusive-tool-lock-stale.lock");
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      path.join(lockPath, "owner.json"),
      `${JSON.stringify({ acquiredAt: Date.now() - 60_000, pid: 999_999 })}\n`,
      "utf8",
    );

    await expect(
      withExclusiveToolLock("exclusive-tool-lock-stale", async () => "recovered", {
        pollIntervalMs: 10,
        staleLockMs: 10,
        waitTimeoutMs: 1_000,
      }),
    ).resolves.toBe("recovered");
  });

  it("recovers stale locks when the recovery guard is orphaned without valid metadata", async () => {
    const toolName = "exclusive-tool-lock-stale-recovery";
    const lockPath = path.join(lockRoot, `${toolName}.lock`);
    const recoveryPath = `${lockPath}.recovery`;
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      path.join(lockPath, "owner.json"),
      `${JSON.stringify({ acquiredAt: Date.now() - 60_000, pid: 999_999 })}\n`,
      "utf8",
    );
    await mkdir(recoveryPath, { recursive: true });
    await writeFile(path.join(recoveryPath, "owner.json"), "not-json\n", "utf8");

    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });

    await expect(
      withExclusiveToolLock(toolName, async () => "recovered", {
        pollIntervalMs: 10,
        staleLockMs: 10,
        waitTimeoutMs: 1_000,
      }),
    ).resolves.toBe("recovered");
  });

  it("times out when a live owner still holds the lock", async () => {
    const lockPath = path.join(lockRoot, "exclusive-tool-lock-live-owner.lock");
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      path.join(lockPath, "owner.json"),
      `${JSON.stringify({ acquiredAt: Date.now() - 60_000, pid: process.pid })}\n`,
      "utf8",
    );

    await expect(
      withExclusiveToolLock("exclusive-tool-lock-live-owner", async () => "unexpected", {
        pollIntervalMs: 10,
        staleLockMs: 10,
        waitTimeoutMs: 100,
      }),
    ).rejects.toThrow(
      "Timed out waiting for the exclusive-tool-lock-live-owner test lock after 100ms.",
    );
  });

  it("keeps stale-lock recovery exclusive when two contenders arrive together", async () => {
    const toolName = "exclusive-tool-lock-race";
    const lockPath = path.join(lockRoot, `${toolName}.lock`);
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      path.join(lockPath, "owner.json"),
      `${JSON.stringify({ acquiredAt: Date.now() - 60_000, pid: 999_999 })}\n`,
      "utf8",
    );

    const events: string[] = [];
    let releaseWinner: (() => void) | undefined;
    const winnerCanFinish = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });
    let enteredBy: "first" | "second" | undefined;
    let winnerEntered: ((label: "first" | "second") => void) | undefined;
    const firstEntry = new Promise<"first" | "second">((resolve) => {
      winnerEntered = resolve;
    });

    const first = withExclusiveToolLock(
      toolName,
      async () => {
        events.push("first-enter");
        if (enteredBy === undefined) {
          enteredBy = "first";
          winnerEntered?.("first");
          await winnerCanFinish;
        }
        events.push("first-exit");
      },
      { pollIntervalMs: 10, staleLockMs: 10, waitTimeoutMs: 1_000 },
    );

    const second = withExclusiveToolLock(
      toolName,
      async () => {
        events.push("second-enter");
        if (enteredBy === undefined) {
          enteredBy = "second";
          winnerEntered?.("second");
          await winnerCanFinish;
        }
        events.push("second-exit");
      },
      { pollIntervalMs: 10, staleLockMs: 10, waitTimeoutMs: 1_000 },
    );

    const winner = await firstEntry;
    const loser = winner === "first" ? "second" : "first";

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(events).toEqual([`${winner}-enter`]);

    if (releaseWinner === undefined) {
      throw new Error("Expected the winning contender release hook to be set.");
    }

    releaseWinner();
    await Promise.all([first, second]);

    expect(events).toEqual([
      `${winner}-enter`,
      `${winner}-exit`,
      `${loser}-enter`,
      `${loser}-exit`,
    ]);
  });
});
