import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { findQubeComponent, planQubeCli, resolveCommand, resolveComponentCommand } from "../dist/index.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const binPath = fileURLToPath(new URL("../dist/bin/qube.js", import.meta.url));

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [binPath, ...args], {
    cwd: packageRoot,
    encoding: "utf8",
    env: { ...process.env, ...options.env }
  });
}

describe("qube composer CLI", () => {
  it("reports package version without invoking component tools", () => {
    const text = runCli(["--version"]);
    assert.equal(text.status, 0);
    assert.equal(text.stdout.trim(), "0.1.1");

    const short = runCli(["-v"]);
    assert.equal(short.status, 0);
    assert.equal(short.stdout.trim(), "0.1.1");

    const json = runCli(["-v", "--json"]);
    assert.equal(json.status, 0);
    assert.deepEqual(JSON.parse(json.stdout), {
      ok: true,
      command: "version",
      package: {
        name: "@tjalve/qube",
        version: "0.1.1"
      },
      version: "0.1.1"
    });
  });

  it("renders the shared command help and schema surface", () => {
    const help = runCli(["--help"]);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Usage:\n  qube <command> \[flags\]/);
    assert.match(help.stdout, /Commands:/);
    assert.match(help.stdout, /components\s+List QUBE component packages and commands\./);
    assert.match(help.stdout, /install\s+Build a guided, supply-chain-safe QUBE install plan\./);
    assert.match(help.stdout, /idea\s+Start Bootstrap from a concise idea\./);
    assert.match(help.stdout, /spec draft\s+Draft the Bootstrap spec artifact\./);
    assert.match(help.stdout, /work-items render\s+Render work item drafts for a provider\./);
    assert.match(help.stdout, /queue\s+Show the Executor issue queue\./);
    assert.match(help.stdout, /start\s+Start or resume Executor issue work\./);
    assert.match(help.stdout, /pr gate\s+Request and inspect configured pull request reviews\./);
    assert.match(help.stdout, /app start\s+Start a local app process for audit work\./);
    assert.match(help.stdout, /doctor\s+Run Quality Control diagnostics\./);
    assert.match(help.stdout, /check\s+Run Quality Control checks for explicit paths\./);
    assert.match(help.stdout, /quality status\s+Show AIQ quality status\./);
    assert.match(help.stdout, /evidence\s+Emit structured AIQ quality evidence\./);
    assert.match(help.stdout, /status\s+Show Umpire continuation status\./);
    assert.match(help.stdout, /schema\s+Render deterministic command schema as JSON\./);

    const runHelp = runCli(["run", "--help"]);
    assert.equal(runHelp.status, 0);
    assert.match(runHelp.stdout, /Usage:\n  qube run \[component\] \[args\]/);
    assert.match(runHelp.stdout, /Run a QUBE component command with passthrough arguments\./);

    const installHelp = runCli(["install", "--help"]);
    assert.equal(installHelp.status, 0);
    assert.match(installHelp.stdout, /Usage:\n  qube install/);
    assert.match(installHelp.stdout, /Dry run: supported/);
    assert.match(installHelp.stdout, /Supply chain: sensitive \(dependency, package-manager\)/);

    const schema = runCli(["schema", "--json"]);
    assert.equal(schema.status, 0);
    const parsed = JSON.parse(schema.stdout);
    assert.equal(parsed.package.name, "@tjalve/qube");
    const commandNames = parsed.commands.map(command => command.name);
    for (const command of ["install", "idea", "spec draft", "milestones", "work-items render", "queue", "start", "branch create", "review gate", "pr gate", "app start", "check", "quality status", "evidence", "status"]) {
      assert.ok(commandNames.includes(command), `expected ${command} in QUBE schema`);
    }
    const installCommand = parsed.commands.find(command => command.name === "install");
    assert.equal(installCommand?.dryRun.supported, true);
    assert.deepEqual(installCommand?.supplyChain.kinds, ["dependency", "package-manager"]);
    assert.deepEqual(
      parsed.sections.components.map(component => component.command),
      ["aib", "aie", "aiq", "aiu"]
    );
    assert.deepEqual(Object.fromEntries(parsed.sections.directCommands.map(command => [command.command, command.component])).status, "aiu");
    assert.deepEqual(Object.fromEntries(parsed.sections.directCommands.map(command => [command.command, command.component]))["pr gate"], "aie");
  });

  it("renders a non-interactive guided install plan as JSON", () => {
    const result = runCli(["install", "--yes", "--dry-run", "--json"]);
    assert.equal(result.status, 0);
    const parsed = JSON.parse(result.stdout);

    assert.equal(parsed.ok, true);
    assert.equal(parsed.command, "install");
    assert.deepEqual(parsed.installPlan.package, {
      name: "@tjalve/qube",
      version: "0.1.1"
    });
    assert.deepEqual(parsed.installPlan.selections, {
      docs: true,
      host: "generic",
      lifecycleScripts: "disabled",
      migration: "none",
      packageManager: "pnpm",
      scope: "local",
      workProvider: "github"
    });
    assert.equal(parsed.installPlan.dryRun, true);
    assert.deepEqual(parsed.installPlan.commands.map(step => step.command), [
      "pnpm add -D --save-exact --ignore-scripts @tjalve/qube@0.1.1",
      "pnpm exec qube components"
    ]);
    assert.match(parsed.installPlan.notes.join("\n"), /No package-manager command is executed/);
  });

  it("renders explicit global npm install commands without prompting", () => {
    const result = runCli([
      "install",
      "--scope",
      "global",
      "--package-manager",
      "npm",
      "--host",
      "codex",
      "--work-provider",
      "github",
      "--lifecycle-scripts",
      "disabled",
      "--docs",
      "--migration",
      "standalone-globals"
    ]);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /QUBE guided install plan/);
    assert.match(result.stdout, /Scope: global/);
    assert.match(result.stdout, /Host surface: codex/);
    assert.match(result.stdout, /npm install --global --ignore-scripts @tjalve\/qube@0\.1\.1/);
    assert.match(result.stdout, /AGENTS\.md policy notes/);
    assert.match(result.stdout, /remove stale standalone global commands/);
    assert.match(result.stdout, /No commands were run\./);
  });

  it("blocks JSON install prompts unless flags or safe defaults are supplied", () => {
    const result = runCli(["install", "--json"]);
    assert.equal(result.status, 2);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: false,
      command: "install",
      error: {
        kind: "prompt-blocked",
        operation: "prompt install scope",
        likelyCause: "Prompts are disabled in JSON output mode.",
        suggestedNextAction: "Provide an explicit flag value or rerun in an interactive terminal.",
        category: "usage",
        exitCode: 2
      }
    });
  });

  it("rejects invalid installer flag selections", () => {
    const result = runCli(["install", "--scope", "shared", "--yes", "--json"]);
    assert.equal(result.status, 2);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.command, "install");
    assert.equal(parsed.error.kind, "invalid-command-usage");
    assert.match(parsed.error.likelyCause, /Expected --scope=shared to be one of: local, global/);

    const planned = planQubeCli(["install", "--scope", "shared", "--yes"]);
    assert.equal(planned.exitCode, 2);
    assert.match(planned.stderr, /Invalid install option --scope=shared/);

    const missingValue = planQubeCli(["install", "--scope", "--yes"]);
    assert.equal(missingValue.exitCode, 2);
    assert.match(missingValue.stderr, /Missing value for install option --scope/);
    assert.match(missingValue.stderr, /local, global/);
  });

  it("lists standalone components without replacing them", () => {
    const result = runCli(["components", "--json"]);
    assert.equal(result.status, 0);

    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(
      parsed.components.map(component => [component.id, component.command, component.packageName]),
      [
        ["bootstrap", "aib", "@tjalve/aib"],
        ["executor", "aie", "@tjalve/aie"],
        ["quality", "aiq", "@tjalve/aiq"],
        ["umpire", "aiu", "@tjalve/aiu"]
      ]
    );
  });

  it("plans dispatch through the selected standalone command", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-path-cwd-"));
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-empty-package-root-"));
    const pathPackageRoot = mkdtempSync(path.join(tmpdir(), "qube-path-package-"));
    const dir = path.join(pathPackageRoot, "bin");
    const command = process.platform === "win32" ? "aib.cmd" : "aib";
    const commandPath = path.join(dir, command);
    await mkdir(dir, { recursive: true });
    await writeFile(commandPath, process.platform === "win32" ? "@echo off\r\necho aib %*\r\n" : "#!/usr/bin/env sh\necho aib \"$@\"\n");
    await writeFile(path.join(pathPackageRoot, "package.json"), `${JSON.stringify({ name: "@tjalve/aib", version: "0.1.1" })}\n`);
    if (process.platform !== "win32") await chmod(commandPath, 0o755);

    const env = { PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}`, OS: process.env.OS };
    assert.equal(resolveCommand("aib", { cwd, env, packageRoot }), commandPath);

    const planned = planQubeCli(["run", "aib", "--", "init", "--dry-run"], { cwd, env, packageRoot });
    assert.equal(planned.exitCode, 0);
    assert.equal(planned.dispatch?.component.command, "aib");
    assert.equal(planned.dispatch?.resolution.source, "path");
    assert.deepEqual(planned.dispatch?.args, ["init", "--dry-run"]);

    const helpDispatch = planQubeCli(["run", "aib", "--help"], { cwd, env, packageRoot });
    assert.equal(helpDispatch.exitCode, 0);
    assert.equal(helpDispatch.dispatch?.component.command, "aib");
    assert.deepEqual(helpDispatch.dispatch?.args, ["--help"]);
  });

  it("maps common QUBE commands to component commands", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-direct-cwd-"));
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-direct-package-root-"));
    const binDir = path.join(packageRoot, "node_modules", ".bin");
    await mkdir(binDir, { recursive: true });

    for (const component of ["aib", "aie", "aiq", "aiu"]) {
      const command = process.platform === "win32" ? `${component}.cmd` : component;
      const commandPath = path.join(binDir, command);
      await writeFile(commandPath, process.platform === "win32" ? `@echo off\r\necho ${component} %*\r\n` : `#!/usr/bin/env sh\necho ${component} "$@"\n`);
      const packageDir = path.join(packageRoot, "node_modules", "@tjalve", component);
      await mkdir(packageDir, { recursive: true });
      await writeFile(path.join(packageDir, "package.json"), `${JSON.stringify({ name: `@tjalve/${component}`, version: findQubeComponent(component).packageVersion })}\n`);
      if (process.platform !== "win32") await chmod(commandPath, 0o755);
    }

    const env = { PATH: process.env.PATH ?? "", OS: process.env.OS };
    const cases = [
      {
        input: ["idea", "Ship a local notes CLI", "--json"],
        component: "aib",
        args: ["init", ".", "--idea", "Ship a local notes CLI", "--json"]
      },
      {
        input: ["idea", "--json"],
        component: "aib",
        args: ["init", ".", "--json"]
      },
      {
        input: ["spec", "draft", "--json"],
        component: "aib",
        args: ["spec", "draft", "--json"]
      },
      {
        input: ["work-items", "render", "--provider", "github", "--json"],
        component: "aib",
        args: ["work-items", "render", "--provider", "github", "--json"]
      },
      {
        input: ["queue", "--json"],
        component: "aie",
        args: ["queue", "--json"]
      },
      {
        input: ["start", "next", "--json"],
        component: "aie",
        args: ["start", "next", "--json"]
      },
      {
        input: ["branch", "create", "84", "--dry-run", "--json"],
        component: "aie",
        args: ["branch", "create", "84", "--dry-run", "--json"]
      },
      {
        input: ["pr", "--help"],
        component: "aie",
        args: ["pr", "--help"]
      },
      {
        input: ["pr", "gate", "87", "--json"],
        component: "aie",
        args: ["pr", "gate", "87", "--json"]
      },
      {
        input: ["app", "start", "--name", "ui-audit", "--", "pnpm", "dev"],
        component: "aie",
        args: ["run", "start", "--name", "ui-audit", "--", "pnpm", "dev"]
      },
      {
        input: ["doctor", "--json"],
        component: "aiq",
        args: ["doctor", "--format", "json"]
      },
      {
        input: ["check", "src", "--json"],
        component: "aiq",
        args: ["check", "src", "--format", "json"]
      },
      {
        input: ["quality", "status", "--json"],
        component: "aiq",
        args: ["status", "--format", "json"]
      },
      {
        input: ["evidence", "--json"],
        component: "aiq",
        args: ["evidence", "--format", "json"]
      },
      {
        input: ["status", "--json"],
        component: "aiu",
        args: ["status", "--json"]
      },
      {
        input: ["continue", "status", "--json"],
        component: "aiu",
        args: ["status", "--json"]
      }
    ];

    for (const testCase of cases) {
      const planned = planQubeCli(testCase.input, { cwd, env, packageRoot });
      assert.equal(planned.exitCode, 0);
      assert.equal(planned.dispatch?.component.command, testCase.component);
      assert.deepEqual(planned.dispatch?.args, testCase.args);
    }
  });

  it("explains ambiguous product-specific commands", () => {
    const planned = planQubeCli(["config", "--json"], {
      cwd: mkdtempSync(path.join(tmpdir(), "qube-ambiguous-cwd-")),
      env: { PATH: "" },
      packageRoot: mkdtempSync(path.join(tmpdir(), "qube-ambiguous-root-"))
    });

    assert.equal(planned.exitCode, 2);
    assert.match(planned.stderr, /Config exists in multiple components/);
    assert.match(planned.stderr, /qube aiq config/);
    assert.match(planned.stderr, /qube aiu config/);
  });

  it("rejects JSON on helper topics that do not support JSON", () => {
    const planned = planQubeCli(["pr", "--json"], {
      cwd: mkdtempSync(path.join(tmpdir(), "qube-topic-json-cwd-")),
      env: { PATH: "" },
      packageRoot: mkdtempSync(path.join(tmpdir(), "qube-topic-json-root-"))
    });

    assert.equal(planned.exitCode, 2);
    assert.match(planned.stderr, /qube pr does not support --json/);
    assert.equal(planned.dispatch, undefined);
  });

  it("prefers install-scoped component binaries over ambient PATH", async () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-install-root-"));
    const binDir = path.join(packageRoot, "node_modules", ".bin");
    const packageDir = path.join(packageRoot, "node_modules", "@tjalve", "aib");
    const pathDir = mkdtempSync(path.join(tmpdir(), "qube-global-bin-"));
    const command = process.platform === "win32" ? "aib.cmd" : "aib";
    const installCommandPath = path.join(binDir, command);
    const pathCommandPath = path.join(pathDir, command);
    await mkdir(binDir, { recursive: true });
    await mkdir(packageDir, { recursive: true });
    await writeFile(installCommandPath, process.platform === "win32" ? "@echo off\r\necho install-scoped %*\r\n" : "#!/usr/bin/env sh\necho install-scoped \"$@\"\n");
    await writeFile(pathCommandPath, process.platform === "win32" ? "@echo off\r\necho path %*\r\n" : "#!/usr/bin/env sh\necho path \"$@\"\n");
    await writeFile(path.join(packageDir, "package.json"), `${JSON.stringify({ name: "@tjalve/aib", version: "0.1.1" })}\n`);
    if (process.platform !== "win32") {
      await chmod(installCommandPath, 0o755);
      await chmod(pathCommandPath, 0o755);
    }

    const component = findQubeComponent("aib");
    assert.ok(component);
    const env = { PATH: `${pathDir}${path.delimiter}${process.env.PATH ?? ""}`, OS: process.env.OS };
    const resolution = resolveComponentCommand(component, { cwd: path.resolve("."), env, packageRoot });

    assert.equal(resolution?.commandPath, installCommandPath);
    assert.equal(resolution?.source, "install");
    assert.equal(resolution?.packageVersion, "0.1.1");
    assert.equal(resolveCommand("aib", { cwd: path.resolve("."), env, packageRoot }), installCommandPath);
  });

  it("refuses a stale same-package binary from PATH", async () => {
    const stalePackageRoot = mkdtempSync(path.join(tmpdir(), "qube-stale-aib-"));
    const binDir = path.join(stalePackageRoot, "bin");
    const command = process.platform === "win32" ? "aib.cmd" : "aib";
    const commandPath = path.join(binDir, command);
    await mkdir(binDir, { recursive: true });
    await writeFile(commandPath, process.platform === "win32" ? "@echo off\r\necho stale %*\r\n" : "#!/usr/bin/env sh\necho stale \"$@\"\n");
    await writeFile(path.join(stalePackageRoot, "package.json"), `${JSON.stringify({ name: "@tjalve/aib", version: "0.0.1" })}\n`);
    if (process.platform !== "win32") await chmod(commandPath, 0o755);

    const env = { PATH: binDir, OS: process.env.OS };
    const planned = planQubeCli(["run", "aib", "status"], { cwd: mkdtempSync(path.join(tmpdir(), "qube-stale-cwd-")), env, packageRoot: mkdtempSync(path.join(tmpdir(), "qube-empty-install-")) });

    assert.equal(planned.exitCode, 4);
    assert.match(planned.stderr, /Refusing aib from PATH/);
    assert.match(planned.stderr, /expected @tjalve\/aib@0\.1\.1, found 0\.0\.1/);
    assert.equal(planned.dispatch, undefined);
  });

  it("refuses PATH component binary when package metadata cannot be verified", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "qube-unverified-path-"));
    const command = process.platform === "win32" ? "aib.cmd" : "aib";
    const commandPath = path.join(dir, command);
    await writeFile(commandPath, process.platform === "win32" ? "@echo off\r\necho unknown %*\r\n" : "#!/usr/bin/env sh\necho unknown \"$@\"\n");
    if (process.platform !== "win32") await chmod(commandPath, 0o755);

    const env = { PATH: dir, OS: process.env.OS };
    const cwd = mkdtempSync(path.join(tmpdir(), "qube-unverified-cwd-"));
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-unverified-install-"));
    const planned = planQubeCli(["run", "aib", "status"], {
      cwd,
      env,
      packageRoot
    });

    assert.equal(planned.exitCode, 4);
    assert.match(planned.stderr, /Refusing aib from PATH/);
    assert.match(planned.stderr, /unable to verify @tjalve\/aib@0\.1\.1/);
    assert.equal(resolveCommand("aib", { cwd, env, packageRoot }), undefined);
  });

  it("dispatches to resolved component command shims", async () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "qube-dispatch-root-"));
    const dir = path.join(packageRoot, "node_modules", ".bin");
    const packageDir = path.join(packageRoot, "node_modules", "@tjalve", "aib");
    const command = process.platform === "win32" ? "aib.cmd" : "aib";
    const commandPath = path.join(dir, command);
    await mkdir(dir, { recursive: true });
    await mkdir(packageDir, { recursive: true });
    await writeFile(commandPath, process.platform === "win32" ? "@echo off\r\necho dispatched %*\r\n" : "#!/usr/bin/env sh\necho dispatched \"$@\"\n");
    await writeFile(path.join(packageDir, "package.json"), `${JSON.stringify({ name: "@tjalve/aib", version: "0.1.0" })}\n`);
    if (process.platform !== "win32") await chmod(commandPath, 0o755);

    const result = runCli(["aib", "status", "--json"], {
      env: {
        PATH: process.env.PATH ?? "",
        QUBE_TEST_PACKAGE_ROOT: packageRoot,
        OS: process.env.OS
      }
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /dispatched status --json/);

    const help = runCli(["aib", "--help"], {
      env: {
        PATH: process.env.PATH ?? "",
        QUBE_TEST_PACKAGE_ROOT: packageRoot,
        OS: process.env.OS
      }
    });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /dispatched --help/);

    const ideaWithoutText = runCli(["idea", "--json"], {
      env: {
        PATH: process.env.PATH ?? "",
        QUBE_TEST_PACKAGE_ROOT: packageRoot,
        OS: process.env.OS
      }
    });
    assert.equal(ideaWithoutText.status, 0);
    assert.match(ideaWithoutText.stdout, /dispatched init \. --json/);
  });

  it("returns an actionable error when a component command is unavailable", () => {
    const component = findQubeComponent("@tjalve/aiq");
    assert.equal(component?.command, "aiq");

    const result = planQubeCli(["run", "aiq"], {
      cwd: mkdtempSync(path.join(tmpdir(), "qube-missing-cwd-")),
      env: { PATH: "" },
      packageRoot: mkdtempSync(path.join(tmpdir(), "qube-missing-root-"))
    });
    assert.equal(result.exitCode, 4);
    assert.match(result.stderr, /Cannot find aiq/);
    assert.match(result.stderr, /Install QUBE with its component dependencies/);
  });
});
