import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { runModelRoutingDoctor } from "../dist/index.js";
import { adapterPackageVersions } from "./workspace-versions.mjs";

const binPath = fileURLToPath(new URL("../dist/bin/qube.js", import.meta.url));

const adapterNames = Object.freeze({
  codex: "@tjalve/qube-adapter-codex",
  cursor: "@tjalve/qube-adapter-cursor",
  opencode: "@tjalve/qube-adapter-opencode",
});

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function runCli(args, fixture) {
  return spawnSync(process.execPath, [binPath, ...args], {
    cwd: fixture.repo,
    encoding: "utf8",
    env: fixture.env,
  });
}

function addExecutable(root, name, output = "") {
  const bin = path.join(root, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  const script = path.join(bin, `${name}-fixture.mjs`);
  writeFileSync(script, `process.stdout.write(${JSON.stringify(output)});\n`, "utf8");
  const command = path.join(bin, process.platform === "win32" ? `${name}.cmd` : name);
  writeFileSync(command, process.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
    : `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`, "utf8");
  if (process.platform !== "win32") chmodSync(command, 0o755);
  return bin;
}

function installHostAdapter(root, host, { isolatedRunner = true } = {}) {
  const name = adapterNames[host];
  const packageDir = path.join(root, "node_modules", ...name.split("/"));
  mkdirSync(packageDir, { recursive: true });
  writeJson(path.join(packageDir, "package.json"), {
    name,
    version: adapterPackageVersions[name],
    type: "module",
    exports: "./index.mjs",
  });
  writeFileSync(path.join(packageDir, "index.mjs"), isolatedRunner
    ? `export const isolatedReviewHostAdapter = { id: ${JSON.stringify(host)}, buildInvocation() { return { args: [], stdin: null }; }, parseEnvelope() { return null; } };\n`
    : "export const adapterFixture = true;\n", "utf8");
}

function qubeConfig(overrides = {}) {
  return {
    version: 1,
    hosts: ["codex", "cursor"],
    workProviders: ["github"],
    ciProviders: ["github"],
    continuousShipping: true,
    umpire: { scope: "standard" },
    quality: { stages: ["build"] },
    review: {
      mode: "isolated",
      harness: "cursor",
      publisher: "user",
      models: ["cursor:cursor-grok-4.6-medium-fast"],
      backup: null,
    },
    mcp: { optIn: false },
    ...overrides,
  };
}

function aieConfig(overrides = {}) {
  return {
    version: 1,
    providers: {
      review: { kind: "github", publisher: { mode: "user" } },
    },
    policy: {
      gates: { qualityControl: true },
      audit: { manualUiAudit: false },
      reviews: {
        mode: "isolated",
        route: { host: "cursor", tier: "review", timeoutSeconds: 600, maxTurns: 8 },
        models: {
          review: { cursor: { model: "cursor-grok-4.6-medium-fast", effort: null } },
          economy: {},
          synthesis: {},
        },
      },
      modelRouting: {
        primary: "primary",
        catalog: [{ id: "primary", host: "codex", transport: "host", costRank: 3, notes: "Primary host model." }],
        routes: {
          "mechanical-implementation": { preferred: "primary", fallback: ["primary"] },
          "exploration-investigation": { preferred: "primary", fallback: ["primary"] },
          "independent-review": { reviewTier: "review" },
          "synthesis-judgment": { preferred: "primary", fallback: ["primary"] },
        },
      },
    },
    ...overrides,
  };
}

function createFixture({ codexRunner = true, cursorRunner = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "qube-hosts-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  const packages = path.join(root, "packages");
  mkdirSync(repo, { recursive: true });
  mkdirSync(home, { recursive: true });
  const initialized = spawnSync("git", ["init", "--quiet", "--initial-branch", "main", repo], { encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);
  installHostAdapter(packages, "codex", { isolatedRunner: codexRunner });
  installHostAdapter(packages, "cursor", { isolatedRunner: cursorRunner });
  const bin = addExecutable(packages, "codex", `${JSON.stringify({ models: [{ slug: "gpt-5.6-sol" }] })}\n`);
  addExecutable(packages, "cursor-agent", "Available models\ncursor-grok-4.6-medium-fast - Grok Medium Fast\n");
  const inheritedPath = process.env.PATH ?? process.env.Path ?? "";
  const executablePath = inheritedPath ? `${bin}${path.delimiter}${inheritedPath}` : bin;
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PATH: executablePath,
    Path: executablePath,
    QUBE_TEST_PACKAGE_ROOT: packages,
  };
  return {
    root,
    repo,
    home,
    packages,
    env,
    repoQube: path.join(repo, ".qube", "init.json"),
    repoAie: path.join(repo, ".qube", "aie", "config.json"),
    globalQube: path.join(home, ".qube", "config.json"),
    globalAie: path.join(home, ".qube", "aie", "config.json"),
  };
}

function seedRepository(fixture) {
  writeJson(fixture.repoQube, qubeConfig());
  writeJson(fixture.repoAie, aieConfig());
  writeFileSync(path.join(fixture.repo, "AGENTS.md"), "existing instructions\n", "utf8");
  mkdirSync(path.join(fixture.repo, ".githooks"), { recursive: true });
  writeFileSync(path.join(fixture.repo, ".githooks", "pre-push"), "existing hook\n", "utf8");
}

function switchArgs(extra = []) {
  return [
    "hosts",
    "--host", "cursor,codex",
    "--review-mode", "isolated",
    "--review-harness", "codex",
    "--review-model", "gpt-5.6-sol",
    ...extra,
    "--json",
  ];
}

describe("qube hosts", () => {
  it("reports current roles without writing files", () => {
    const fixture = createFixture();
    seedRepository(fixture);
    const overlay = path.join(fixture.repo, ".qube", "aie", "config.local.json");
    writeJson(overlay, { policy: { modelRouting: { deliberately: "conflicting" } } });
    const emptyPackages = path.join(fixture.root, "empty-packages");
    mkdirSync(emptyPackages, { recursive: true });
    fixture.env.QUBE_TEST_PACKAGE_ROOT = emptyPackages;
    const beforeQube = readFileSync(fixture.repoQube, "utf8");
    const beforeAie = readFileSync(fixture.repoAie, "utf8");
    const beforeOverlay = readFileSync(overlay, "utf8");

    const result = runCli(["hosts", "--json"], fixture);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "status");
    assert.equal(payload.changed, false);
    assert.deepEqual(payload.current, {
      hosts: ["codex", "cursor"],
      primaryHost: "codex",
      review: { mode: "isolated", harness: "cursor", model: "cursor-grok-4.6-medium-fast" },
    });
    assert.equal(readFileSync(fixture.repoQube, "utf8"), beforeQube);
    assert.equal(readFileSync(fixture.repoAie, "utf8"), beforeAie);
    assert.equal(readFileSync(overlay, "utf8"), beforeOverlay);
  });

  it("dry-runs only host config writes and leaves managed settings untouched", () => {
    const fixture = createFixture();
    seedRepository(fixture);
    const protectedFiles = [fixture.repoQube, fixture.repoAie, path.join(fixture.repo, "AGENTS.md"), path.join(fixture.repo, ".githooks", "pre-push")];
    const before = new Map(protectedFiles.map(file => [file, readFileSync(file, "utf8")]));

    const result = runCli(switchArgs(["--dry-run"]), fixture);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "plan");
    assert.deepEqual(payload.plannedFields.map(field => field.id), ["hosts", "review.mode", "review.harness", "review.models"]);
    assert.deepEqual(payload.writes.map(write => path.normalize(write.path)), [path.normalize(fixture.repoQube), path.normalize(fixture.repoAie)]);
    assert.ok(payload.writes.every(write => write.changed));
    for (const [file, content] of before) assert.equal(readFileSync(file, "utf8"), content, file);
  });

  it("updates global host layers while preserving publisher, quality, audit, and MCP settings", () => {
    const fixture = createFixture();
    const outsideRepository = path.join(fixture.root, "outside-repository");
    mkdirSync(outsideRepository, { recursive: true });
    const globalFixture = { ...fixture, repo: outsideRepository };
    writeJson(fixture.globalQube, qubeConfig());
    writeJson(fixture.globalAie, aieConfig());

    const result = runCli(switchArgs(["--global"]), globalFixture);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "apply");
    assert.equal(payload.changed, true);
    const qube = readJson(fixture.globalQube);
    assert.deepEqual(qube.hosts, ["cursor", "codex"]);
    assert.deepEqual(qube.quality, { stages: ["build"] });
    assert.deepEqual(qube.mcp, { optIn: false });
    assert.equal(qube.review.publisher, "user");
    assert.equal(qube.review.harness, "codex");
    const aie = readJson(fixture.globalAie);
    assert.deepEqual(aie.providers.review.publisher, { mode: "user" });
    assert.equal(aie.policy.gates.qualityControl, true);
    assert.equal(aie.policy.audit.manualUiAudit, false);
    assert.equal(aie.policy.modelRouting.catalog.find(entry => entry.id === aie.policy.modelRouting.primary).host, "cursor");
    assert.equal(aie.policy.reviews.route.host, "codex");
    assert.deepEqual(aie.policy.reviews.models.review.codex, { model: "gpt-5.6-sol", effort: null });
    assert.equal(aie.policy.reviews.models.review.cursor, undefined);
  });

  it("switches isolated review to a model from the new host live catalog", () => {
    const fixture = createFixture();
    seedRepository(fixture);
    const beforeAie = readJson(fixture.repoAie);
    const beforeAgents = readFileSync(path.join(fixture.repo, "AGENTS.md"), "utf8");
    const beforeHook = readFileSync(path.join(fixture.repo, ".githooks", "pre-push"), "utf8");

    const result = runCli(switchArgs(), fixture);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).mode, "apply");
    const qube = readJson(fixture.repoQube);
    assert.equal(qube.review.harness, "codex");
    assert.deepEqual(qube.review.models, ["codex:gpt-5.6-sol"]);
    const aie = readJson(fixture.repoAie);
    assert.equal(aie.policy.reviews.route.host, "codex");
    assert.deepEqual(aie.policy.reviews.models.review.codex, { model: "gpt-5.6-sol", effort: null });
    assert.equal(aie.policy.reviews.models.review.cursor, undefined);
    assert.deepEqual(aie.providers, beforeAie.providers);
    assert.deepEqual(aie.policy.gates, beforeAie.policy.gates);
    assert.deepEqual(aie.policy.audit, beforeAie.policy.audit);
    assert.equal(readFileSync(path.join(fixture.repo, "AGENTS.md"), "utf8"), beforeAgents);
    assert.equal(readFileSync(path.join(fixture.repo, ".githooks", "pre-push"), "utf8"), beforeHook);
  });

  it("does not offer a PATH-only host and rejects an adapter without an isolated runner before writes", () => {
    const pathOnly = createFixture();
    seedRepository(pathOnly);
    addExecutable(pathOnly.packages, "opencode", "");
    const before = readFileSync(pathOnly.repoQube, "utf8");
    const unavailable = runCli(["hosts", "--host", "opencode", "--review-mode", "host", "--json"], pathOnly);
    assert.equal(unavailable.status, 2, `${unavailable.stdout}\n${unavailable.stderr}`);
    const unavailablePayload = JSON.parse(unavailable.stdout);
    assert.equal(unavailablePayload.reasonCode, "missing-adapter");
    assert.match(unavailablePayload.error, /does not have an installed compatible adapter/i);
    assert.equal(readFileSync(pathOnly.repoQube, "utf8"), before);

    const missingRunner = createFixture({ codexRunner: false });
    seedRepository(missingRunner);
    const beforeQube = readFileSync(missingRunner.repoQube, "utf8");
    const beforeAie = readFileSync(missingRunner.repoAie, "utf8");
    const rejected = runCli(switchArgs(), missingRunner);
    assert.equal(rejected.status, 2, `${rejected.stdout}\n${rejected.stderr}`);
    const rejectedPayload = JSON.parse(rejected.stdout);
    assert.equal(rejectedPayload.reasonCode, "missing-adapter");
    assert.match(rejectedPayload.error, /isolated Review runner/i);
    assert.equal(readFileSync(missingRunner.repoQube, "utf8"), beforeQube);
    assert.equal(readFileSync(missingRunner.repoAie, "utf8"), beforeAie);
  });

  it("fails on a machine-local host override before either repository config changes", () => {
    const fixture = createFixture();
    seedRepository(fixture);
    const overlay = path.join(fixture.repo, ".qube", "aie", "config.local.json");
    writeJson(overlay, { policy: { reviews: { route: { host: "cursor" } } } });
    const beforeQube = readFileSync(fixture.repoQube, "utf8");
    const beforeAie = readFileSync(fixture.repoAie, "utf8");

    const result = runCli(switchArgs(), fixture);

    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
    assert.match(JSON.parse(result.stdout).error, /config\.local\.json|machine-local/i);
    assert.equal(readFileSync(fixture.repoQube, "utf8"), beforeQube);
    assert.equal(readFileSync(fixture.repoAie, "utf8"), beforeAie);
  });

  it("repairs stale Executor routing on an explicit unchanged QUBE selection", () => {
    const fixture = createFixture();
    seedRepository(fixture);
    writeJson(fixture.repoQube, qubeConfig({
      hosts: ["cursor", "codex"],
      review: {
        mode: "isolated",
        harness: "codex",
        publisher: "user",
        models: ["codex:gpt-5.6-sol"],
        backup: null,
      },
    }));
    const stale = aieConfig();
    stale.policy.modelRouting.catalog[0].host = "codex";
    stale.policy.reviews.route.host = "cursor";
    writeJson(fixture.repoAie, stale);

    const result = runCli(switchArgs(), fixture);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).mode, "apply");
    const repaired = readJson(fixture.repoAie);
    assert.equal(repaired.policy.modelRouting.catalog.find(entry => entry.id === repaired.policy.modelRouting.primary).host, "cursor");
    assert.equal(repaired.policy.reviews.route.host, "codex");
  });

  it("makes the successful repository switch visible to model-routing doctor", async () => {
    const fixture = createFixture();
    seedRepository(fixture);

    const result = runCli(switchArgs(), fixture);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const doctor = await runModelRoutingDoctor(fixture.repo, () => true);
    assert.equal(doctor.status, "ok");
    assert.equal(doctor.resolution.primary.host, "cursor");
    assert.equal(doctor.resolution.routes["independent-review"].host, "codex");
    assert.equal(doctor.resolution.routes["independent-review"].model, "gpt-5.6-sol");
    assert.equal(readFileSync(path.join(fixture.repo, "AGENTS.md"), "utf8"), "existing instructions\n");
    assert.equal(readFileSync(path.join(fixture.repo, ".githooks", "pre-push"), "utf8"), "existing hook\n");
    assert.equal(existsSync(path.join(fixture.repo, ".cursor", "commands", "make-it-so.md")), false);
  });
});
