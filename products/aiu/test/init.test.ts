import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const aiuBin = path.join(repoRoot, "dist/src/bin/aiu.js");
const tempRoots: string[] = [];

describe("init planner", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("emits dry-run JSON without writing files", async () => {
    const target = await createRepoRoot();
    const result = await runCli(target, ["init", "--dry-run", "--json"]);
    const parsed = JSON.parse(result.stdout) as InitEnvelope;

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.equal(parsed.ok, true);
    assert.equal(parsed.command, "init");
    assert.equal(parsed.init.dryRun, true);
    assert.deepEqual(parsed.init.tools, ["opencode", "codex", "claude-code", "grok-build"]);
    assert.equal(parsed.init.files.length, 7);
    assert.equal(parsed.init.config.operation, "create");
    assert.equal(parsed.init.recommendedNextCommand, "aiu config --json");
    assert.equal(existsSync(path.join(target, ".qube", "aiu", "config.json")), false);
    assert.equal(existsSync(path.join(target, ".opencode", "plugins", "ai-umpire-continuation.ts")), false);
  });

  it("applies non-interactive host defaults for each selected tool", async () => {
    const cases = [
      {
        tool: "opencode",
        file: path.join(".opencode", "plugins", "ai-umpire-continuation.ts"),
      },
      {
        tool: "codex",
        file: path.join("plugins", "ai-umpire", "hooks", "hooks.json"),
      },
      {
        tool: "claude-code",
        file: path.join(".claude", "settings.json"),
      },
      {
        tool: "grok-build",
        file: path.join(".grok", "hooks", "ai-umpire.json"),
      },
    ];

    for (const { tool, file } of cases) {
      const target = await createRepoRoot();
      const result = await runCli(target, ["init", "--tool", tool, "--json"]);
      const parsed = JSON.parse(result.stdout) as InitEnvelope;
      const config = JSON.parse(await readFile(path.join(target, ".qube", "aiu", "config.json"), "utf8")) as {
        hosts: { enabled: string[]; modes: Record<string, string[]>; stopHookBlocking: Record<string, boolean> };
      };

      assert.equal(result.exitCode, 0, tool);
      assert.equal(parsed.init.ok, true, tool);
      assert.deepEqual(parsed.init.tools, [tool], tool);
      assert.equal(existsSync(path.join(target, file)), true, tool);
      assert.deepEqual(config.hosts.enabled, [tool], tool);
      assert.deepEqual(config.hosts.modes[tool], tool === "opencode" ? ["continue", "repair", "wait", "stop"] : ["continue", "repair", "stop"], tool);
      assert.equal(config.hosts.stopHookBlocking[tool], tool !== "opencode", tool);

      if (tool === "opencode") {
        assert.match(
          await readFile(path.join(target, file), "utf8"),
          /createAiuOpenCodeServerPlugin/,
        );
      } else if (tool === "codex") {
        const hooks = JSON.parse(await readFile(path.join(target, file), "utf8")) as {
          Stop: Array<{ hooks: Array<{ command: string; type: string }> }>;
        };
        const marketplace = JSON.parse(await readFile(path.join(target, ".agents", "plugins", "marketplace.json"), "utf8")) as {
          plugins: Array<{ name: string; source: { path: string } }>;
        };
        assert.equal(existsSync(path.join(target, "plugins", "ai-umpire", ".codex-plugin", "plugin.json")), true);
        assert.equal(existsSync(path.join(target, "plugins", "ai-umpire", "skills", "ai-umpire", "SKILL.md")), true);
        assert.equal(hooks.Stop[0]?.hooks[0]?.type, "command");
        assert.equal(hooks.Stop[0]?.hooks[0]?.command, "pnpm exec aiu hook-stop --tool codex");
        assert.equal(marketplace.plugins[0]?.name, "ai-umpire");
        assert.equal(marketplace.plugins[0]?.source.path, "./plugins/ai-umpire");
      } else if (tool === "claude-code") {
        const settings = JSON.parse(await readFile(path.join(target, file), "utf8")) as {
          hooks: { Stop: Array<{ hooks: Array<{ command: string; type: string }> }> };
        };
        assert.equal(settings.hooks.Stop[0]?.hooks[0]?.type, "command");
        assert.equal(settings.hooks.Stop[0]?.hooks[0]?.command, "pnpm exec aiu hook-stop --tool claude-code");
      } else if (tool === "grok-build") {
        const hooks = JSON.parse(await readFile(path.join(target, file), "utf8")) as {
          hooks: { Stop: Array<{ hooks: Array<{ command: string; type: string }> }> };
        };
        assert.equal(hooks.hooks.Stop[0]?.hooks[0]?.type, "command");
        assert.equal(hooks.hooks.Stop[0]?.hooks[0]?.command, "pnpm exec aiu hook-stop --tool grok-build");
      }
    }
  });

  it("initializes an arbitrary supported harness subset in one plan", async () => {
    const target = await createRepoRoot();
    const result = await runCli(target, ["init", "--tool", "opencode,claude-code", "--json"]);
    const parsed = JSON.parse(result.stdout) as InitEnvelope;
    const config = JSON.parse(await readFile(path.join(target, ".qube", "aiu", "config.json"), "utf8")) as {
      hosts: { enabled: string[] };
    };

    assert.equal(result.exitCode, 0);
    assert.equal(parsed.init.ok, true);
    assert.deepEqual(parsed.init.tools, ["opencode", "claude-code"]);
    assert.deepEqual(parsed.init.hostProfiles.map((profile) => profile.tool), ["opencode", "claude-code"]);
    assert.deepEqual(config.hosts.enabled, ["opencode", "claude-code"]);
    assert.deepEqual(
      parsed.init.files.map((file) => file.relativePath),
      [
        path.join(".opencode", "plugins", "ai-umpire-continuation.ts"),
        path.join(".claude", "settings.json"),
      ],
    );
    assert.equal(existsSync(path.join(target, ".agents", "plugins", "marketplace.json")), false);
    assert.equal(existsSync(path.join(target, ".grok", "hooks", "ai-umpire.json")), false);
  });

  it("applies all supported harnesses once and reports a repeat as a no-op", async () => {
    const target = await createRepoRoot();
    const selection = "opencode,codex,claude-code,grok-build";

    const first = await runCli(target, ["init", "--tool", selection, "--json"]);
    const firstPlan = JSON.parse(first.stdout) as InitEnvelope;
    const second = await runCli(target, ["init", "--tool", selection, "--json"]);
    const secondPlan = JSON.parse(second.stdout) as InitEnvelope;
    const config = JSON.parse(await readFile(path.join(target, ".qube", "aiu", "config.json"), "utf8")) as {
      hosts: { enabled: string[] };
    };

    assert.equal(first.exitCode, 0);
    assert.equal(firstPlan.init.ok, true);
    assert.deepEqual(firstPlan.init.tools, ["opencode", "codex", "claude-code", "grok-build"]);
    assert.equal(firstPlan.init.config.operation, "create");
    assert.ok(firstPlan.init.files.every((file) => file.operation === "create"));
    assert.equal(second.exitCode, 0);
    assert.equal(secondPlan.ok, true);
    assert.equal(secondPlan.init.ok, true);
    assert.deepEqual(secondPlan.init.tools, firstPlan.init.tools);
    assert.equal(secondPlan.init.config.operation, "skip");
    assert.ok(secondPlan.init.files.every((file) => file.operation === "skip"));
    assert.deepEqual(config.hosts.enabled, firstPlan.init.tools);
  });

  it("uses the selected harness subset as the exact enabled set", async () => {
    const target = await createRepoRoot();
    await runCli(target, ["init", "--tool", "all", "--json"]);

    const result = await runCli(target, ["init", "--tool", "codex,grok-build", "--json"]);
    const parsed = JSON.parse(result.stdout) as InitEnvelope;
    const config = JSON.parse(await readFile(path.join(target, ".qube", "aiu", "config.json"), "utf8")) as {
      hosts: { enabled: string[] };
    };

    assert.equal(result.exitCode, 0);
    assert.equal(parsed.init.config.operation, "update");
    assert.deepEqual(parsed.init.tools, ["codex", "grok-build"]);
    assert.deepEqual(parsed.init.config.hosts, ["codex", "grok-build"]);
    assert.deepEqual(config.hosts.enabled, ["codex", "grok-build"]);
  });

  it("configures Ready-only and standard post-issue scopes without host assets", async () => {
    const cases = [
      { scope: "ready", quality: false, whip: false, packageDefaults: false },
      { scope: "standard", quality: true, whip: true, packageDefaults: true },
    ] as const;

    for (const expected of cases) {
      const target = await createRepoRoot();
      const result = await runCli(target, ["init", "--tool", "none", "--post-issue-scope", expected.scope, "--json"]);
      const parsed = JSON.parse(result.stdout) as InitEnvelope;
      const config = JSON.parse(await readFile(path.join(target, ".qube", "aiu", "config.json"), "utf8")) as {
        postIssueScope: string;
        hosts: { enabled: string[] };
        planning: { enabled: boolean };
        quality: { enabled: boolean };
        whip: { enabled: boolean; usePackageDefaults: boolean };
      };

      assert.equal(result.exitCode, 0, expected.scope);
      assert.equal(parsed.init.postIssueScope, expected.scope);
      assert.deepEqual(parsed.init.tools, []);
      assert.deepEqual(parsed.init.files, []);
      assert.equal(parsed.init.hostProfiles.length, 0);
      assert.deepEqual(config.hosts.enabled, []);
      assert.equal(config.postIssueScope, expected.scope);
      assert.equal(config.planning.enabled, false);
      assert.equal(config.quality.enabled, expected.quality);
      assert.equal(config.whip.enabled, expected.whip);
      assert.equal(config.whip.usePackageDefaults, expected.packageDefaults);
      assert.equal(existsSync(path.join(target, ".opencode")), false);
      assert.equal(existsSync(path.join(target, ".claude")), false);
      assert.equal(existsSync(path.join(target, ".grok")), false);
      assert.equal(existsSync(path.join(target, ".agents")), false);
    }
  });

  it("uses only configured Umpire tasks for custom post-issue scope", async () => {
    const target = await createRepoRoot();
    const configPath = path.join(target, ".qube", "aiu", "config.json");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      version: 1,
      postIssueScope: "ready",
      teamSetting: "preserve",
      whip: {
        tasks: [{
          id: "research-cycle",
          title: "Run the research cycle",
          prompt: "Run the repository research cycle and preserve measured evidence.",
          priority: 10,
        }],
      },
    }), "utf8");

    const result = await runCli(target, ["init", "--tool", "none", "--post-issue-scope", "custom", "--json"]);
    const parsed = JSON.parse(result.stdout) as InitEnvelope;
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      postIssueScope: string;
      teamSetting: string;
      planning: { enabled: boolean };
      quality: { enabled: boolean };
      whip: { enabled: boolean; usePackageDefaults: boolean; tasks: Array<{ id: string }> };
    };

    assert.equal(result.exitCode, 0);
    assert.equal(parsed.init.postIssueScope, "custom");
    assert.equal(parsed.init.config.operation, "update");
    assert.equal(config.teamSetting, "preserve");
    assert.equal(config.postIssueScope, "custom");
    assert.equal(config.planning.enabled, false);
    assert.equal(config.quality.enabled, false);
    assert.equal(config.whip.enabled, true);
    assert.equal(config.whip.usePackageDefaults, false);
    assert.deepEqual(config.whip.tasks.map((task) => task.id), ["research-cycle"]);
  });

  it("fails custom post-issue scope before writes when no tasks are configured", async () => {
    const target = await createRepoRoot();
    const result = await runCli(target, ["init", "--tool", "none", "--post-issue-scope", "custom", "--json"]);
    const parsed = JSON.parse(result.stdout) as InitEnvelope;

    assert.equal(result.exitCode, 3);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.init.ok, false);
    assert.equal(parsed.init.postIssueScope, "custom");
    assert.match(parsed.init.conflicts[0]?.reason ?? "", /at least one configured Umpire task/);
    assert.equal(existsSync(path.join(target, ".qube", "aiu", "config.json")), false);
  });

  it("rejects Cursor because Umpire continuation is unavailable", async () => {
    const target = await createRepoRoot();
    const result = await runCli(target, ["init", "--tool", "cursor", "--json"]);
    const parsed = JSON.parse(result.stdout) as { error: { kind: string; likelyCause: string } };

    assert.equal(result.exitCode, 2);
    assert.equal(parsed.error.kind, "invalid-command-usage");
    assert.match(parsed.error.likelyCause, /--tool=cursor/);
    assert.equal(existsSync(path.join(target, ".qube", "aiu", "config.json")), false);
  });

  it("merges the AI Umpire plugin into a shared Codex marketplace", async () => {
    const target = await createRepoRoot();
    const marketplacePath = path.join(target, ".agents", "plugins", "marketplace.json");
    await mkdir(path.dirname(marketplacePath), { recursive: true });
    await writeFile(marketplacePath, JSON.stringify({
      interface: { displayName: "Team tools" },
      name: "team-tools",
      schemaVersion: 7,
      plugins: [
        { name: "lint", source: { path: "./plugins/lint", source: "local" } },
        { category: "Old", name: "ai-umpire", source: { path: "./old-aiu", source: "local" } },
        { name: "renamed-aiu", source: { path: "./plugins/ai-umpire", source: "local" } },
        { name: "format", source: { path: "./plugins/format", source: "local" } },
      ],
    }), "utf8");

    const first = await runCli(target, ["init", "--tool", "codex", "--json"]);
    const firstPlan = JSON.parse(first.stdout) as InitEnvelope;
    const firstContent = await readFile(marketplacePath, "utf8");
    const marketplace = JSON.parse(firstContent) as {
      interface: { displayName: string };
      name: string;
      schemaVersion: number;
      plugins: Array<{
        category?: string;
        name: string;
        policy?: { authentication: string; installation: string };
        source: { path: string; source: string };
      }>;
    };

    assert.equal(first.exitCode, 0);
    assert.equal(firstPlan.init.ok, true);
    assert.equal(findFile(firstPlan, path.join(".agents", "plugins", "marketplace.json")).operation, "update");
    assert.equal(marketplace.name, "team-tools");
    assert.equal(marketplace.interface.displayName, "Team tools");
    assert.equal(marketplace.schemaVersion, 7);
    assert.deepEqual(marketplace.plugins.map((plugin) => plugin.name), ["lint", "ai-umpire", "format"]);
    const managedPlugins = marketplace.plugins.filter((plugin) => plugin.name === "ai-umpire" || plugin.source.path === "./plugins/ai-umpire");
    assert.equal(managedPlugins.length, 1);
    assert.equal(managedPlugins[0]?.category, "Coding");
    assert.deepEqual(managedPlugins[0]?.policy, { authentication: "ON_INSTALL", installation: "AVAILABLE" });
    assert.deepEqual(managedPlugins[0]?.source, { path: "./plugins/ai-umpire", source: "local" });

    const second = await runCli(target, ["init", "--tool", "codex", "--json"]);
    const secondPlan = JSON.parse(second.stdout) as InitEnvelope;

    assert.equal(second.exitCode, 0);
    assert.equal(secondPlan.init.ok, true);
    assert.equal(findFile(secondPlan, path.join(".agents", "plugins", "marketplace.json")).operation, "skip");
    assert.equal(await readFile(marketplacePath, "utf8"), firstContent);
  });

  it("merges the AI Umpire Stop hook into shared Claude Code settings", async () => {
    const target = await createRepoRoot();
    const settingsPath = path.join(target, ".claude", "settings.json");
    const managedCommand = "pnpm exec aiu hook-stop --tool claude-code";
    const preToolUse = [{ matcher: "Bash", hooks: [{ type: "command", command: "echo inspect" }] }];
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, JSON.stringify({
      env: { KEEP: "yes" },
      permissions: { allow: ["Read"] },
      hooks: {
        PreToolUse: preToolUse,
        Stop: [
          {
            matcher: "first",
            hooks: [
              { type: "command", command: "echo before" },
              { type: "command", command: managedCommand, timeout: 1 },
            ],
          },
          { hooks: [{ type: "command", command: managedCommand }] },
          { matcher: "other", hooks: [{ type: "command", command: "echo after" }] },
        ],
      },
    }), "utf8");

    const first = await runCli(target, ["init", "--tool", "claude-code", "--json"]);
    const firstPlan = JSON.parse(first.stdout) as InitEnvelope;
    const firstContent = await readFile(settingsPath, "utf8");
    const settings = JSON.parse(firstContent) as {
      env: { KEEP: string };
      permissions: { allow: string[] };
      hooks: {
        PreToolUse: typeof preToolUse;
        Stop: Array<{ matcher?: string; hooks: Array<{ type: string; command: string; timeout?: number }> }>;
      };
    };

    assert.equal(first.exitCode, 0);
    assert.equal(firstPlan.init.ok, true);
    assert.equal(findFile(firstPlan, path.join(".claude", "settings.json")).operation, "update");
    assert.deepEqual(settings.env, { KEEP: "yes" });
    assert.deepEqual(settings.permissions, { allow: ["Read"] });
    assert.deepEqual(settings.hooks.PreToolUse, preToolUse);
    assert.deepEqual(
      settings.hooks.Stop.flatMap((group) => group.hooks).filter((hook) => hook.command !== managedCommand).map((hook) => hook.command),
      ["echo before", "echo after"],
    );
    const managedHooks = settings.hooks.Stop.flatMap((group) => group.hooks).filter((hook) => hook.command === managedCommand);
    assert.deepEqual(managedHooks, [{ command: managedCommand, type: "command" }]);

    const second = await runCli(target, ["init", "--tool", "claude-code", "--json"]);
    const secondPlan = JSON.parse(second.stdout) as InitEnvelope;

    assert.equal(second.exitCode, 0);
    assert.equal(secondPlan.init.ok, true);
    assert.equal(findFile(secondPlan, path.join(".claude", "settings.json")).operation, "skip");
    assert.equal(await readFile(settingsPath, "utf8"), firstContent);
  });

  it("does not replace malformed shared JSON when --force is provided", async () => {
    const cases = [
      { tool: "codex", file: path.join(".agents", "plugins", "marketplace.json") },
      { tool: "claude-code", file: path.join(".claude", "settings.json") },
    ];

    for (const { tool, file } of cases) {
      const target = await createRepoRoot();
      const sharedPath = path.join(target, file);
      await mkdir(path.dirname(sharedPath), { recursive: true });
      await writeFile(sharedPath, "{not-json\n", "utf8");

      const result = await runCli(target, ["init", "--tool", tool, "--force", "--json"]);
      const parsed = JSON.parse(result.stdout) as InitEnvelope;

      assert.equal(result.exitCode, 3, tool);
      assert.equal(parsed.ok, false, tool);
      assert.equal(parsed.error?.kind, "init-conflict", tool);
      assert.equal(parsed.error?.category, "validation", tool);
      assert.equal(parsed.init.ok, false, tool);
      assert.equal(findFile(parsed, file).operation, "conflict", tool);
      assert.match(findFile(parsed, file).reason ?? "", /will not replace/, tool);
      assert.equal(await readFile(sharedPath, "utf8"), "{not-json\n", tool);
      assert.equal(existsSync(path.join(target, ".qube", "aiu", "config.json")), false, tool);
    }
  });

  it("initializes Grok Build without Codex or Claude Code files", async () => {
    const target = await createRepoRoot();
    const result = await runCli(target, ["init", "--tool", "grok-build", "--json"]);
    const parsed = JSON.parse(result.stdout) as InitEnvelope;
    const config = JSON.parse(await readFile(path.join(target, ".qube", "aiu", "config.json"), "utf8")) as {
      hosts: { enabled: string[] };
    };

    assert.equal(result.exitCode, 0);
    assert.equal(parsed.init.ok, true);
    assert.deepEqual(parsed.init.tools, ["grok-build"]);
    assert.deepEqual(config.hosts.enabled, ["grok-build"]);
    assert.equal(parsed.init.files.length, 1);
    assert.equal(existsSync(path.join(target, ".grok", "hooks", "ai-umpire.json")), true);
    assert.equal(existsSync(path.join(target, ".agents", "plugins", "marketplace.json")), false);
    assert.equal(existsSync(path.join(target, "plugins", "ai-umpire", "hooks", "hooks.json")), false);
    assert.equal(existsSync(path.join(target, ".claude", "settings.json")), false);
    assert.equal(existsSync(path.join(target, ".opencode", "plugins", "ai-umpire-continuation.ts")), false);
  });

  it("applies --tool all through host capability profiles", async () => {
    const target = await createRepoRoot();
    const result = await runCli(target, ["init", "--tool", "all", "--json"]);
    const parsed = JSON.parse(result.stdout) as InitEnvelope;
    const config = JSON.parse(await readFile(path.join(target, ".qube", "aiu", "config.json"), "utf8")) as {
      hosts: { enabled: string[]; capabilities: Record<string, unknown>; modes: Record<string, string[]>; stopHookBlocking: Record<string, boolean> };
      trustedStateCommands: Record<string, { argv: string[] }>;
    };

    assert.equal(result.exitCode, 0);
    assert.deepEqual(parsed.init.hostProfiles.map((profile) => profile.tool), ["opencode", "codex", "claude-code", "grok-build"]);
    assert.deepEqual(parsed.init.hostProfiles.map((profile) => profile.supportLevel), ["supported", "experimental", "experimental", "experimental"]);
    assert.deepEqual(config.hosts.enabled, ["opencode", "codex", "claude-code", "grok-build"]);
    assert.ok(config.hosts.capabilities.opencode);
    assert.ok(config.hosts.capabilities.codex);
    assert.ok(config.hosts.capabilities["claude-code"]);
    assert.ok(config.hosts.capabilities["grok-build"]);
    assert.deepEqual(config.hosts.modes.opencode, ["continue", "repair", "wait", "stop"]);
    assert.deepEqual(config.hosts.modes.codex, ["continue", "repair", "stop"]);
    assert.deepEqual(config.hosts.modes["claude-code"], ["continue", "repair", "stop"]);
    assert.deepEqual(config.hosts.modes["grok-build"], ["continue", "repair", "stop"]);
    assert.deepEqual(config.hosts.stopHookBlocking, { opencode: false, codex: true, "claude-code": true, "grok-build": true });
    assert.deepEqual(config.trustedStateCommands.work.argv, ["aie", "status", "--json"]);
  });

  it("preserves existing host overrides while seeding missing init defaults", async () => {
    const target = await createRepoRoot();
    await mkdir(path.join(target, ".qube", "aiu"), { recursive: true });
    await writeFile(path.join(target, ".qube", "aiu", "config.json"), JSON.stringify({
      version: 1,
      hosts: {
        enabled: ["codex"],
        capabilities: {
          codex: {
            promptDelivery: "none",
          },
        },
        modes: {
          codex: [],
        },
        stopHookBlocking: {
          codex: false,
        },
      },
    }), "utf8");

    const result = await runCli(target, ["init", "--tool", "codex", "--force", "--json"]);
    const parsed = JSON.parse(result.stdout) as InitEnvelope;
    const config = JSON.parse(await readFile(path.join(target, ".qube", "aiu", "config.json"), "utf8")) as {
      hosts: {
        capabilities: { codex: { promptDelivery?: string; stopHook?: boolean } };
        modes: { codex: string[] };
        stopHookBlocking: { codex: boolean };
      };
    };

    assert.equal(result.exitCode, 0);
    assert.equal(parsed.init.ok, true);
    assert.equal(config.hosts.capabilities.codex.promptDelivery, "none");
    assert.equal(config.hosts.capabilities.codex.stopHook, true);
    assert.deepEqual(config.hosts.modes.codex, []);
    assert.equal(config.hosts.stopHookBlocking.codex, false);
  });

  it("preserves conflicting host files unless --force is explicit", async () => {
    const target = await createRepoRoot();
    const wrapper = path.join(target, ".opencode", "plugins", "ai-umpire-continuation.ts");
    await mkdir(path.dirname(wrapper), { recursive: true });
    await writeFile(wrapper, "user content\n", "utf8");

    const blocked = await runCli(target, ["init", "--tool", "opencode", "--json"]);
    const blockedPlan = JSON.parse(blocked.stdout) as InitEnvelope;

    assert.equal(blocked.exitCode, 3);
    assert.equal(blockedPlan.ok, false);
    assert.equal(blockedPlan.error?.kind, "init-conflict");
    assert.equal(blockedPlan.error?.exitCode, 3);
    assert.equal(blockedPlan.init.ok, false);
    assert.equal(blockedPlan.init.files[0]?.operation, "conflict");
    assert.equal(await readFile(wrapper, "utf8"), "user content\n");
    assert.equal(existsSync(path.join(target, ".qube", "aiu", "config.json")), false);

    const forced = await runCli(target, ["init", "--tool", "opencode", "--force", "--json"]);
    const forcedPlan = JSON.parse(forced.stdout) as InitEnvelope;

    assert.equal(forced.exitCode, 0);
    assert.equal(forcedPlan.init.ok, true);
    assert.equal(forcedPlan.init.files[0]?.operation, "update");
    assert.match(await readFile(wrapper, "utf8"), /Managed by @tjalve\/aiu/);
  });

  it("does not apply a stale plan over newly conflicting files", async () => {
    const target = await createRepoRoot();
    const { applyAiuInitPlan, planAiuInit } = await import(pathToFileURL(path.join(repoRoot, "dist/src/init.js")).href) as {
      applyAiuInitPlan: (plan: InitPlan) => InitPlan;
      planAiuInit: (options: { cwd: string; tool: string }) => InitPlan;
    };
    const plan = planAiuInit({ cwd: target, tool: "opencode" });
    const wrapper = path.join(target, ".opencode", "plugins", "ai-umpire-continuation.ts");
    await mkdir(path.dirname(wrapper), { recursive: true });
    await writeFile(wrapper, "late user content\n", "utf8");

    const applied = applyAiuInitPlan(plan);

    assert.equal(applied.ok, false);
    assert.equal(applied.files[0]?.operation, "conflict");
    assert.equal(await readFile(wrapper, "utf8"), "late user content\n");
    assert.equal(existsSync(path.join(target, ".qube", "aiu", "config.json")), false);
  });

  it("makes zero writes when the repository root becomes a linked directory after planning", async (t) => {
    const target = await createRepoRoot();
    const originalRoot = `${target}-original`;
    tempRoots.push(originalRoot);
    const outsideRoot = await mkdtemp(path.join(tmpdir(), "aiu-init-linked-root-"));
    tempRoots.push(outsideRoot);
    await mkdir(path.join(outsideRoot, ".git"));
    const sentinelPath = path.join(outsideRoot, "sentinel.txt");
    await writeFile(sentinelPath, "outside sentinel\n", "utf8");
    const { applyAiuInitPlan, planAiuInit } = await import(pathToFileURL(path.join(repoRoot, "dist/src/init.js")).href) as {
      applyAiuInitPlan: (plan: InitPlan) => InitPlan;
      planAiuInit: (options: { cwd: string; tool: string }) => InitPlan;
    };
    const plan = planAiuInit({ cwd: target, tool: "opencode" });
    await rename(target, originalRoot);
    try {
      await symlink(outsideRoot, target, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("repository root link creation is unavailable on this platform");
        return;
      }
      throw error;
    }

    const applied = applyAiuInitPlan(plan);

    assert.equal(applied.ok, false);
    assert.ok(applied.conflicts.some((conflict) => conflict.relativePath === "." && /symbolic link or directory junction/u.test(conflict.reason)));
    assert.equal(await readFile(sentinelPath, "utf8"), "outside sentinel\n");
    assert.equal(existsSync(path.join(outsideRoot, ".opencode", "plugins", "ai-umpire-continuation.ts")), false);
    assert.equal(existsSync(path.join(outsideRoot, ".qube", "aiu", "config.json")), false);
    assert.equal(existsSync(path.join(originalRoot, ".qube", "aiu", "config.json")), false);
  });

  it("makes zero writes when a managed parent becomes a linked directory after planning", async (t) => {
    const target = await createRepoRoot();
    const outsideRoot = await mkdtemp(path.join(tmpdir(), "aiu-init-linked-parent-"));
    tempRoots.push(outsideRoot);
    const { applyAiuInitPlan, planAiuInit } = await import(pathToFileURL(path.join(repoRoot, "dist/src/init.js")).href) as {
      applyAiuInitPlan: (plan: InitPlan) => InitPlan;
      planAiuInit: (options: { cwd: string; tool: string }) => InitPlan;
    };
    const plan = planAiuInit({ cwd: target, tool: "opencode" });
    try {
      await symlink(outsideRoot, path.join(target, ".opencode"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("directory link creation is unavailable on this platform");
        return;
      }
      throw error;
    }

    const applied = applyAiuInitPlan(plan);
    const wrapper = applied.files.find((file) => file.relativePath === path.join(".opencode", "plugins", "ai-umpire-continuation.ts"));

    assert.equal(applied.ok, false);
    assert.equal(wrapper?.operation, "conflict");
    assert.match(wrapper?.reason ?? "", /symbolic links or directory junctions/u);
    assert.equal(existsSync(path.join(outsideRoot, "plugins", "ai-umpire-continuation.ts")), false);
    assert.equal(existsSync(path.join(target, ".qube", "aiu", "config.json")), false);
  });

  it("makes zero writes when a managed leaf becomes a matching symbolic link after planning", async (t) => {
    const target = await createRepoRoot();
    const outsideRoot = await mkdtemp(path.join(tmpdir(), "aiu-init-linked-leaf-"));
    tempRoots.push(outsideRoot);
    const { applyAiuInitPlan, planAiuInit } = await import(pathToFileURL(path.join(repoRoot, "dist/src/init.js")).href) as {
      applyAiuInitPlan: (plan: InitPlan) => InitPlan;
      planAiuInit: (options: { cwd: string; tool: string }) => InitPlan;
    };
    const plan = planAiuInit({ cwd: target, tool: "opencode" });
    const plannedWrapper = plan.files.find((file) => file.relativePath === path.join(".opencode", "plugins", "ai-umpire-continuation.ts"));
    assert(plannedWrapper);
    const wrapperPath = path.join(target, plannedWrapper.relativePath);
    const outsideWrapper = path.join(outsideRoot, "ai-umpire-continuation.ts");
    await mkdir(path.dirname(wrapperPath), { recursive: true });
    await writeFile(outsideWrapper, plannedWrapper.content, "utf8");
    try {
      await symlink(outsideWrapper, wrapperPath, "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("file link creation is unavailable on this platform");
        return;
      }
      throw error;
    }

    const applied = applyAiuInitPlan(plan);
    const wrapper = applied.files.find((file) => file.relativePath === plannedWrapper.relativePath);

    assert.equal(applied.ok, false);
    assert.equal(wrapper?.operation, "conflict");
    assert.match(wrapper?.reason ?? "", /symbolic links or directory junctions/u);
    assert.equal(await readFile(outsideWrapper, "utf8"), plannedWrapper.content);
    assert.equal(existsSync(path.join(target, ".qube", "aiu", "config.json")), false);
  });

  it("treats unreadable managed paths as conflicts", async () => {
    const target = await createRepoRoot();
    const wrapper = path.join(target, ".opencode", "plugins", "ai-umpire-continuation.ts");
    await mkdir(wrapper, { recursive: true });

    const result = await runCli(target, ["init", "--tool", "opencode", "--json"]);
    const parsed = JSON.parse(result.stdout) as InitEnvelope;

    assert.equal(result.exitCode, 3);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error?.kind, "init-conflict");
    assert.equal(parsed.init.ok, false);
    assert.equal(parsed.init.files[0]?.operation, "conflict");
    assert.match(parsed.init.files[0]?.reason ?? "", /could not be read/);
  });

  it("compares existing config semantically and reports merged config details", async () => {
    const target = await createRepoRoot();
    await runCli(target, ["init", "--tool", "all", "--json"]);
    const config = JSON.parse(await readFile(path.join(target, ".qube", "aiu", "config.json"), "utf8"));
    await writeFile(path.join(target, ".qube", "aiu", "config.json"), JSON.stringify(config), "utf8");

    const result = await runCli(target, ["init", "--tool", "all", "--dry-run", "--json"]);
    const parsed = JSON.parse(result.stdout) as InitEnvelope;

    assert.equal(result.exitCode, 0);
    assert.equal(parsed.init.config.operation, "skip");
    assert.deepEqual(parsed.init.config.hosts, ["opencode", "codex", "claude-code", "grok-build"]);
    assert.deepEqual(parsed.init.config.trustedStateCommands, ["work"]);
  });

  it("human output names created, updated, skipped, and conflicted files", async () => {
    const target = await createRepoRoot();
    const result = await runCli(target, ["init", "--dry-run"]);

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Created:/);
    assert.match(result.stdout, /Updated:/);
    assert.match(result.stdout, /Skipped:/);
    assert.match(result.stdout, /Conflicts:/);
    assert.match(result.stdout, /Config changes:/);
  });
});

interface InitEnvelope {
  readonly ok: boolean;
  readonly command: string;
  readonly error?: {
    readonly kind: string;
    readonly category: string;
    readonly exitCode: number;
  };
  readonly init: {
    readonly ok: boolean;
    readonly dryRun: boolean;
    readonly postIssueScope: string;
    readonly tools: string[];
    readonly hostProfiles: Array<{ tool: string; supportLevel: string }>;
    readonly files: Array<{ relativePath: string; operation: string; reason?: string }>;
    readonly config: { operation: string; hosts: string[]; trustedStateCommands: string[] };
    readonly conflicts: Array<{ relativePath: string; reason: string }>;
    readonly recommendedNextCommand: string;
  };
}

function findFile(plan: InitEnvelope, relativePath: string): InitEnvelope["init"]["files"][number] {
  const file = plan.init.files.find((candidate) => candidate.relativePath === relativePath);
  assert(file, `Expected init plan to contain ${relativePath}`);
  return file;
}

interface InitPlan {
  readonly ok: boolean;
  readonly conflicts: Array<{ readonly relativePath: string; readonly reason: string }>;
  readonly files: Array<{
    readonly relativePath: string;
    readonly absolutePath: string;
    readonly operation: string;
    readonly reason: string;
    readonly content: string;
  }>;
}

async function createRepoRoot(): Promise<string> {
  const target = await mkdtemp(path.join(tmpdir(), "aiu-init-"));
  tempRoots.push(target);
  await mkdir(path.join(target, ".git"));
  return target;
}

async function runCli(cwd: string, input: readonly string[]) {
  try {
    const result = await execFileAsync(process.execPath, [aiuBin, ...input], { cwd });
    return {
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    assert(error !== null && typeof error === "object");
    const failed = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      exitCode: failed.code ?? 1,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
    };
  }
}
