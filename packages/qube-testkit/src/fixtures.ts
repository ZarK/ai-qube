import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import type { ReviewItem, WorkItem } from "@tjalve/qube-core";

import type { RoleHarness } from "./types.js";

export function matchesPattern(message: string, pattern: RegExp): boolean {
  // Clone without the global flag so lastIndex cannot poison repeated suite runs.
  const flags = pattern.flags.replaceAll("g", "");
  return new RegExp(pattern.source, flags).test(message);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function assertFixtureFilesBound(harness: RoleHarness): void {
  assert.ok(
    harness.fixtureRoot && harness.fixtureRoot.trim().length > 0,
    `${harness.role} must set fixtureRoot so fixtureFiles are bound to on-disk fixtures.`,
  );
  const root = join(harness.fixtureRoot);
  for (const relativePath of harness.fixtureFiles) {
    assert.ok(relativePath.trim().length > 0, `${harness.role} fixture file names must be non-empty.`);
    // Keep fixture names repository-relative under fixtureRoot; reject absolute escape hatches.
    assert.equal(
      isAbsolute(relativePath),
      false,
      `${harness.role} fixture file must be relative to fixtureRoot (got absolute path ${relativePath}).`,
    );
    assert.equal(
      relativePath.includes(".."),
      false,
      `${harness.role} fixture file must stay under fixtureRoot (got path traversal ${relativePath}).`,
    );
    const absolutePath = join(root, relativePath);
    assert.ok(
      absolutePath === root || absolutePath.startsWith(root.endsWith("\\") || root.endsWith("/") ? root : `${root}\\`) || absolutePath.startsWith(`${root}/`),
      `${harness.role} fixture file escaped fixtureRoot: ${relativePath}.`,
    );
    assert.ok(
      existsSync(absolutePath),
      `${harness.role} fixture file is missing or unbound: ${relativePath}.`,
    );
  }
}

export function assertNoSecretMaterial(summary: string, label: string): void {
  // Keep connection reports free of raw tokens, passwords, and fixture stderr dumps.
  assert.equal(/\b(ghp_|gho_|github_pat_|sk-|xox[baprs]-)\w+/i.test(summary), false, `${label} must not include token-like material.`);
  assert.equal(/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(summary), false, `${label} must not include private key material.`);
  assert.equal(/\bpassword\s*[:=]\s*\S+/i.test(summary), false, `${label} must not include password assignments.`);
}

export function assertWorkItemShape(item: WorkItem, adapterId: string): void {
  assert.equal(item.key.providerId, adapterId);
  assert.ok(item.key.id.trim().length > 0, "Work item key.id must be non-empty.");
  assert.ok(item.displayId.trim().length > 0, "Work item displayId must be non-empty.");
  assert.ok(item.title.trim().length > 0, "Work item title must be non-empty.");
  assert.ok(item.state === "open" || item.state === "closed", `Unexpected work item state ${item.state}.`);
  assert.ok(["in-progress", "ready", "blocked", "unknown"].includes(item.status), `Unexpected work status ${item.status}.`);
  assert.ok(["critical", "high", "medium", "low", "none"].includes(item.priority), `Unexpected work priority ${item.priority}.`);
  assert.ok(Array.isArray(item.blockers), "Work item blockers must be an array.");
  assert.ok(Array.isArray(item.blockedBy), "Work item blockedBy must be an array.");
  assert.ok(item.checklist && Number.isInteger(item.checklist.total), "Work item checklist.total must be an integer.");
  assert.ok(item.source && item.source.providerId === adapterId, "Work item source.providerId must match adapter id.");
}

export function assertReviewItemShape(item: ReviewItem, adapterId: string): void {
  assert.equal(item.key.providerId, adapterId);
  assert.ok(item.key.id.trim().length > 0);
  assert.ok(item.displayId.trim().length > 0);
  assert.ok(item.title.trim().length > 0);
  assert.ok(Array.isArray(item.feedback), "Review feedback must be an array.");
  assert.ok(Array.isArray(item.mergeBlockers), "Review mergeBlockers must be an array.");
  assert.ok(Array.isArray(item.conversations), "Review conversations must be an array.");
  assert.ok(Array.isArray(item.checks), "Review checks must be an array.");
  assert.ok(item.source && item.source.providerId === adapterId);
}
