import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { claudeCodeHostProfile } from "@tjalve/qube-adapter-claude-code";
import { codexHostProfile } from "@tjalve/qube-adapter-codex";
import { grokBuildHostProfile } from "@tjalve/qube-adapter-grok-build";
import { opencodeHostProfile } from "@tjalve/qube-adapter-opencode";

import { loadAiuConfig } from "../dist/src/config.js";
import {
  evaluateAiuHostRuntimePolicy,
  getAiuHostCapabilityProfile,
  getAllAiuHostCapabilityProfiles,
  getDefaultHostCapabilityOverrides,
  getDefaultHostModes,
  getDefaultStopHookBlocking,
} from "../dist/src/host_policy.js";

describe("host runtime policy", () => {
  it("exposes provider-neutral profiles and explicit support states", () => {
    const profiles = getAllAiuHostCapabilityProfiles();

    assert.deepEqual(profiles.map((profile) => profile.tool), ["opencode", "codex", "claude-code", "grok-build"]);
    assert.deepEqual(profiles.map((profile) => profile.supportLevel), ["supported", "experimental", "experimental", "experimental"]);
    assert.equal(getAiuHostCapabilityProfile("opencode").capabilities.promptDelivery.support, "supported");
    assert.equal(getAiuHostCapabilityProfile("codex").stopHook.blocksByDefault, true);
    assert.equal(getAiuHostCapabilityProfile("claude-code").capabilities.stopHook.support, "experimental");
    assert.equal(getAiuHostCapabilityProfile("grok-build").managedFiles.length, 1);
    assert.equal(getAiuHostCapabilityProfile("grok-build").stopHook.support, "experimental");
    assert.equal(getAiuHostCapabilityProfile("grok-build").stopHook.blocksByDefault, true);
    const grokBuild = profiles.find((profile) => profile.tool === "grok-build");
    assert.ok(grokBuild);
    assert.equal(grokBuild.managedFiles[0]?.relativePath.replaceAll("\\", "/"), ".grok/hooks/ai-umpire.json");
    assert.match(grokBuild.managedFiles[0]?.content ?? "", /hook-stop --tool grok-build/);
  });

  it("derives continuation, probe, recovery, and trust facts from canonical host profiles", () => {
    const canonical = [
      ["opencode", opencodeHostProfile],
      ["codex", codexHostProfile],
      ["claude-code", claudeCodeHostProfile],
      ["grok-build", grokBuildHostProfile],
    ] as const;
    for (const [host, shared] of canonical) {
      const profile = getAiuHostCapabilityProfile(host);
      assert.equal(shared.id, host);
      assert.equal(profile.supportLevel, shared.umpire.continuation.support, host);
      assert.equal(profile.capabilities.promptDelivery.delivery, shared.umpire.continuation.delivery, host);
      assert.equal(profile.currentIssueRecovery, shared.umpire.continuation.currentIssueRecovery, host);
      assert.equal(profile.probe.support, shared.umpire.probe.support, host);
      assert.deepEqual(profile.probe.command, shared.umpire.probe.support === "unsupported" ? undefined : shared.umpire.probe.command, host);
      assert.deepEqual(profile.trustSteps, shared.trust.actions.map((action) => action.description), host);
      assert.deepEqual(
        profile.managedFiles.map((file) => file.relativePath.replaceAll("\\", "/")).sort(),
        shared.trust.actions.flatMap((action) => action.kind === "review-files" ? action.paths : []).sort(),
        host,
      );
    }
  });

  it("uses safe init defaults for host modes and capability overrides", () => {
    assert.deepEqual(getDefaultHostModes("opencode"), ["continue", "repair", "wait", "stop"]);
    assert.deepEqual(getDefaultHostModes("codex"), ["continue", "repair", "stop"]);
    assert.deepEqual(getDefaultHostModes("claude-code"), ["continue", "repair", "stop"]);
    assert.deepEqual(getDefaultHostModes("grok-build"), ["continue", "repair", "stop"]);
    assert.equal(getDefaultStopHookBlocking("opencode"), false);
    assert.equal(getDefaultStopHookBlocking("codex"), true);
    assert.equal(getDefaultHostCapabilityOverrides("opencode").promptDelivery, "host");
    assert.equal(getDefaultHostCapabilityOverrides("codex").promptDelivery, "stdout");
    assert.equal(Object.hasOwn(getDefaultHostCapabilityOverrides("codex"), "userActivity"), false);
  });

  it("reports disabled and experimental host mode policy distinctly", () => {
    const disabled = evaluateAiuHostRuntimePolicy(
      {
        enabled: ["opencode"],
        capabilities: { opencode: { promptDelivery: "none" } },
        modes: { opencode: ["continue"] },
        stopHookBlocking: {},
      },
      ["continue", "repair", "wait", "stop"],
    );
    const experimental = evaluateAiuHostRuntimePolicy(
      {
        enabled: ["grok-build"],
        capabilities: {},
        modes: { "grok-build": ["continue"] },
        stopHookBlocking: { "grok-build": true },
      },
      ["continue", "repair", "wait", "stop"],
    );

    assert.equal(disabled.errors[0]?.kind, "host-capability-disabled");
    assert.equal(experimental.warnings[0]?.kind, "host-capability-experimental");
  });

  it("falls back to global continuation modes when host modes are not explicit", () => {
    const report = evaluateAiuHostRuntimePolicy(
      {
        enabled: ["grok-build"],
        capabilities: {},
        modes: {},
        stopHookBlocking: { "grok-build": true },
      },
      ["continue", "stop"],
    );

    assert.deepEqual(report.modeChecks.map((item) => item.mode), ["continue", "stop"]);
    assert.equal(report.warnings[0]?.kind, "host-capability-experimental");
  });

  it("preserves explicit empty host modes as disabled for that host", () => {
    const report = evaluateAiuHostRuntimePolicy(
      {
        enabled: ["codex"],
        capabilities: {},
        modes: { codex: [] },
        stopHookBlocking: {},
      },
      ["continue", "stop"],
    );

    assert.deepEqual(report.modeChecks, []);
  });

  it("surfaces host policy diagnostics during config validation", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "aiu-host-policy-"));
    try {
      await mkdir(path.join(repoRoot, ".qube", "aiu"), { recursive: true });
      await writeFile(path.join(repoRoot, ".qube", "aiu", "config.json"), JSON.stringify({
        version: 1,
        hosts: {
          enabled: ["opencode", "grok-build"],
          capabilities: {
            opencode: {
              promptDelivery: "none",
            },
          },
          modes: {
            opencode: ["continue", "stop"],
            "grok-build": ["continue"],
          },
          stopHookBlocking: { "grok-build": true },
        },
      }));

      const result = loadAiuConfig({ cwd: repoRoot });

      assert.equal(result.ok, false);
      assert.ok(result.diagnostics.some((item) => item.kind === "host-capability-disabled" && item.severity === "error"));
      assert.ok(result.diagnostics.some((item) => item.kind === "host-capability-experimental" && item.severity === "warning"));
      assert.equal(result.diagnostics.some((item) => item.kind === "host-stop-hook-blocking-unsafe"), false);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("reports stdout continuation as unavailable when Stop hook blocking is off", () => {
    const report = evaluateAiuHostRuntimePolicy(
      {
        enabled: ["codex"],
        capabilities: {},
        modes: { codex: ["continue", "repair", "stop"] },
        stopHookBlocking: { codex: false },
      },
      ["continue", "repair", "wait", "stop"],
    );

    assert.deepEqual(report.errors.map((item) => item.mode), ["continue", "repair"]);
    assert.match(report.errors[0]?.suggestedNextAction ?? "", /hosts\.stopHookBlocking\.codex/);
  });
});
