import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  appendAiuContinuationLog,
  readAiuHostActivation,
  resolveAiuContinuationPaths,
  resolveAiuHostActivationPath,
  writeAiuHostActivation,
} from "../dist/src/continuation_store.js";
import { getDefaultAiuConfig } from "../dist/src/config.js";

describe("continuation persistence store", () => {
  it("records only schema-valid host activation evidence", async () => {
    const target = await mkdtemp(path.join(tmpdir(), "aiu-host-activation-"));
    try {
      const paths = resolveAiuContinuationPaths(target, getDefaultAiuConfig());
      writeAiuHostActivation(paths, {
        schemaVersion: 1,
        host: "claude-code",
        delivery: "stdout",
        event: "stop-hook",
        trustedStateFingerprint: "0".repeat(64),
        observedAt: "2026-05-23T12:00:00.000Z",
      });

      assert.equal(readAiuHostActivation(paths, "claude-code")?.host, "claude-code");
      await writeFile(resolveAiuHostActivationPath(paths, "claude-code"), JSON.stringify({ schemaVersion: 1, host: "codex" }), "utf8");
      assert.equal(readAiuHostActivation(paths, "claude-code"), undefined);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it("redacts token-like values in bounded continuation logs", async () => {
    const target = await mkdtemp(path.join(tmpdir(), "aiu-continuation-log-"));
    try {
      const paths = resolveAiuContinuationPaths(target, getDefaultAiuConfig());
      appendAiuContinuationLog(paths, {
        event: "decision",
        observedAt: "2026-05-23T12:00:00.000Z",
        adapterErrors: [`token=${"ghp_" + "A".repeat(36)}`],
      });

      const log = await readFile(paths.logPath, "utf8");
      assert.match(log, /token=\[redacted\]/);
      assert.doesNotMatch(log, /ghp_[A-Za-z0-9_]+/);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it("rotates continuation logs before they grow without bound", async () => {
    const target = await mkdtemp(path.join(tmpdir(), "aiu-continuation-rotate-"));
    try {
      const paths = resolveAiuContinuationPaths(target, getDefaultAiuConfig());
      for (let index = 0; index < 80; index += 1) {
        appendAiuContinuationLog(paths, {
          event: "decision",
          observedAt: "2026-05-23T12:00:00.000Z",
          message: "x".repeat(1_000),
        });
      }

      const current = await stat(paths.logPath);
      const rotated = await stat(`${paths.logPath}.1`);
      assert.ok(current.size <= 64 * 1024);
      assert.ok(rotated.size <= 64 * 1024);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });
});
