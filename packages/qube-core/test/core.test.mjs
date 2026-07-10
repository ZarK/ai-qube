import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import * as core from "../dist/index.js";
import {
  AUTORESEARCH_EVALUATOR_KINDS,
  AUTORESEARCH_OBJECTIVE_SHAPES,
  AUTORESEARCH_TARGET_KINDS,
  autoresearchReadinessChecklist,
  findQubeProduct,
  normalizeWorkItem,
  qubeCommandSurfaceContracts,
  qubePathContracts,
  qubeProductContracts,
  REPO_LAYOUT_KINDS,
  qubeRepoArtifactContracts
} from "../dist/index.js";

const require = createRequire(import.meta.url);

describe("qube core contracts", () => {
  it("is publishable because public products depend on it at runtime", () => {
    const manifest = require("../package.json");
    assert.equal(manifest.private, undefined);
    assert.equal(manifest.publishConfig?.access, "public");
    assert.equal(manifest.publishConfig?.registry, "https://registry.npmjs.org/");
  });

  it("keeps product contracts standalone and provider-neutral", () => {
    assert.deepEqual(qubeProductContracts.map((product) => product.id), [
      "bootstrap",
      "executor",
      "quality",
      "umpire"
    ]);
    assert.ok(qubeProductContracts.every((product) => product.standalone === true));
    assert.equal(findQubeProduct("@tjalve/aiq")?.commandName, "aiq");
  });

  it("keeps host integration surfaces explicit per product", () => {
    const surfaces = new Map(qubeProductContracts.map((product) => [product.id, product.surfaces]));

    assert.deepEqual(surfaces.get("bootstrap"), ["cli", "github", "gitlab", "linear", "jira", "codex", "opencode", "claude-code", "grok-build"]);
    assert.deepEqual(surfaces.get("executor"), ["cli", "github", "gitlab", "linear", "jira", "jenkins", "codex", "opencode", "claude-code", "grok-build"]);
    assert.deepEqual(surfaces.get("quality"), ["cli"]);
    assert.deepEqual(surfaces.get("umpire"), ["cli", "opencode", "claude-code", "grok-build"]);
  });

  it("declares provider connection contracts with read-only bounded probes", () => {
    const contracts = [
      core.githubAdapterContract,
      core.gitLabAdapterContract,
      core.linearAdapterContract,
      core.jiraAdapterContract,
      core.jenkinsAdapterContract,
    ];
    assert.deepEqual(contracts.map(contract => contract.connection.authMethod), [
      "cli-delegated",
      "token-env",
      "token-env",
      "basic-env",
      "token-env",
    ]);
    assert.ok(contracts.every(contract => contract.connection.probe.readOnly === true));
    assert.ok(contracts.every(contract => contract.connection.probe.timeoutMs > 0));
    assert.ok(contracts.every(contract => contract.connection.credentialUrl.length > 0));
    assert.ok(contracts.every(contract => contract.connection.scopes.length > 0));
  });

  it("keeps skipped and unavailable probes explicit instead of silently passing", async () => {
    const offline = await core.runConnectionProbe(core.linearConnectionContract, { mode: "offline" });
    const missingFixture = await core.runConnectionProbe(core.linearConnectionContract, { mode: "fixture" });
    const missingCredential = await core.runConnectionProbe(core.linearConnectionContract, {
      mode: "fixture",
      fixture: { http: { status: 200, body: { data: { viewer: { id: "fixture" } } } } },
    });
    const denied = await core.runConnectionProbe(core.linearConnectionContract, {
      mode: "fixture",
      env: { LINEAR_API_KEY: "fixture-key" },
      config: { teamId: "fixture-team" },
      fixture: { http: { status: 401, body: { error: "denied" } } },
    });
    assert.equal(offline.status, "unverified");
    assert.equal(missingFixture.status, "unverified");
    assert.equal(missingCredential.status, "fail");
    assert.equal(denied.status, "fail");

    let execCalls = 0;
    let fetchCalls = 0;
    const mismatchedHttp = await core.runConnectionProbe(core.githubConnectionContract, {
      mode: "fixture",
      fixture: { http: { status: 200, body: { ok: true } } },
      exec: async () => {
        execCalls += 1;
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    });
    const mismatchedCommand = await core.runConnectionProbe(core.gitLabConnectionContract, {
      mode: "fixture",
      env: { GITLAB_TOKEN: "fixture-token", GITLAB_PROJECT_ID: "group/project" },
      config: { projectId: "group/project", baseUrl: "https://gitlab.example.com" },
      fixture: { command: { exitCode: 0, stdout: "ok", stderr: "" } },
      fetch: async () => {
        fetchCalls += 1;
        return { status: 200, body: { id: 1 } };
      },
    });
    assert.equal(mismatchedHttp.status, "fail");
    assert.equal(mismatchedCommand.status, "fail");
    assert.equal(execCalls, 0);
    assert.equal(fetchCalls, 0);
    assert.match(mismatchedHttp.summary, /command result|Fixture mode/i);
    assert.match(mismatchedCommand.summary, /HTTP result|Fixture mode/i);
  });

  it("rejects empty or wrong-type identity payloads from read-only probes", async () => {
    const cases = [
      [core.gitLabConnectionContract, { GITLAB_TOKEN: "token" }, { projectId: "group/project" }, { id: null }],
      [core.linearConnectionContract, { LINEAR_API_KEY: "key" }, { teamId: "team" }, { data: { viewer: { id: "" } } }],
      [core.jiraConnectionContract, { JIRA_EMAIL: "user@example.com", JIRA_API_TOKEN: "token" }, { baseUrl: "https://jira.example.com" }, { accountId: false }],
    ];
    for (const [contract, env, config, body] of cases) {
      const result = await core.runConnectionProbe(contract, { mode: "fixture", env, config, fixture: { http: { status: 200, body } } });
      assert.equal(result.status, "fail", contract.adapterId);
      assert.match(result.summary, /unexpected read-only response/);
    }
  });

  it("preserves command timeout classification and bounds provider JSON responses", async () => {
    const timedOut = await core.runConnectionProbe(core.githubConnectionContract, {
      mode: "fixture",
      timeoutMs: 25,
      fixture: { command: { exitCode: 1, timedOut: true } },
    });
    assert.equal(timedOut.status, "fail");
    assert.match(timedOut.summary, /timed out after 25ms/);

    const denied = new Response('{"error":"denied"}', { status: 401 });
    assert.equal(await core.readConnectionJsonResponse(denied, 1), undefined);
    assert.equal(denied.bodyUsed, false);

    const accepted = new Response('{"viewer":{"id":"fixture"}}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    assert.deepEqual(await core.readConnectionJsonResponse(accepted, 1024), { viewer: { id: "fixture" } });

    const oversized = new Response(`{"value":"${"x".repeat(64)}"}`, { status: 200 });
    await assert.rejects(() => core.readConnectionJsonResponse(oversized, 32), /32-byte limit/);
  });

  it("exports canonical repository layout kinds for provider contracts", () => {
    assert.ok(REPO_LAYOUT_KINDS.includes("single-app-service"));
    assert.ok(REPO_LAYOUT_KINDS.includes("javascript-typescript-workspace"));
    assert.ok(REPO_LAYOUT_KINDS.includes("generated-vendor-heavy"));
    assert.ok(REPO_LAYOUT_KINDS.includes("unknown"));
    assert.equal(new Set(REPO_LAYOUT_KINDS).size, REPO_LAYOUT_KINDS.length);
  });

  it("exports canonical autoresearch arena contracts for setup and evaluator handoff", () => {
    assert.ok(AUTORESEARCH_TARGET_KINDS.includes("code"));
    assert.ok(AUTORESEARCH_TARGET_KINDS.includes("document-corpus"));
    assert.ok(AUTORESEARCH_OBJECTIVE_SHAPES.includes("direct-metric"));
    assert.ok(AUTORESEARCH_OBJECTIVE_SHAPES.includes("judge-rubric"));
    assert.ok(AUTORESEARCH_EVALUATOR_KINDS.includes("command-metric"));
    assert.ok(AUTORESEARCH_EVALUATOR_KINDS.includes("rubric-review"));

    const checklist = autoresearchReadinessChecklist({
      schemaVersion: 1,
      classification: "needs-clarification",
      goal: "make it better",
      mutableSurfaces: [],
      invariants: [],
      blockingQuestions: [{ id: "goal", text: "What should improve?", reason: "Goal is ambiguous." }],
      readinessChecklist: [],
      nextAction: "Answer blocking questions."
    });
    assert.ok(checklist.includes("target unresolved"));
    assert.ok(checklist.includes("blocking questions open"));
  });

  it("classifies command, path, and repo artifact surfaces", () => {
    const aiqStandalone = qubeCommandSurfaceContracts.find((entry) => entry.productId === "quality" && entry.qubeFacing === false);
    assert.equal(aiqStandalone?.classification, "standalone package command");
    assert.match(aiqStandalone?.commandPattern ?? "", /bench/);
    assert.match(aiqStandalone?.commandPattern ?? "", /serve/);

    const workflowConfigs = qubeRepoArtifactContracts.filter((entry) => entry.classification === "implementation-time workflow policy");
    assert.ok(workflowConfigs.some((entry) => entry.pathPattern === "products/*/aie.config.json"));
    assert.ok(workflowConfigs.every((entry) => entry.productInstalledSurface === false));

    assert.ok(qubePathContracts.some((entry) => entry.pathPattern === ".qube/" && entry.classification === "shared QUBE namespace"));
    assert.ok(qubePathContracts.some((entry) => entry.pathPattern.includes(".qube/aiq/config.json")));
    assert.ok(qubePathContracts.some((entry) => entry.pathPattern === ".qube/aiu/config.json" && entry.committed === true));
    assert.ok(qubePathContracts.some((entry) => entry.pathPattern.includes(".qube/aiu/state") && entry.committed === false));
  });

  it("keeps checked-in matrix docs aligned with core contracts", () => {
    const commandSurfaceDoc = readRepoDoc("docs/qube-command-surfaces.md");
    const hostSurfaceDoc = readRepoDoc("docs/qube-host-surfaces.md");
    const pathsDoc = readRepoDoc("docs/qube-paths-and-artifacts.md");

    for (const product of qubeProductContracts) {
      assert.match(hostSurfaceDoc, new RegExp(product.packageName.replace("/", "\\/")));
    }
    for (const command of qubeCommandSurfaceContracts) {
      assert.match(commandSurfaceDoc, new RegExp(escapeRegExp(markdownTableCellText(command.commandPattern))));
    }
    for (const pathContract of qubePathContracts) {
      assert.match(pathsDoc, new RegExp(escapeRegExp(pathContract.pathPattern)));
    }
  });

  it("normalizes provider source fields when normalizing work items", () => {
    const item = normalizeWorkItem({
      key: { providerId: " linear ", id: " ENG-123 " },
      displayId: " ENG-123 ",
      title: " Linear adapter ",
      body: "Issue body",
      url: null,
      state: "open",
      status: "ready",
      priority: "high",
      project: null,
      sequence: null,
      source: {
        providerId: " linear ",
        resourceKind: "work-item",
        resourceId: " ENG-123 ",
        url: null,
        metadata: {}
      }
    });

    assert.deepEqual(item.key, { providerId: "linear", id: "ENG-123" });
    assert.deepEqual(item.source, {
      providerId: "linear",
      resourceKind: "work-item",
      resourceId: "ENG-123",
      url: null,
      metadata: {}
    });
  });

  it("keeps provider-neutral review contracts owned by focused modules", () => {
    const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
    const files = readdirSync(srcDir).filter((name) => name.endsWith(".ts"));
    const definitions = new Map([
      ["ReviewItem", "review_item.ts"],
      ["GateEvidence", "gate_evidence.ts"],
      ["ReviewForgeProvider", "review_forge.ts"],
      ["ReviewParticipant", "review_participant.ts"]
    ]);

    for (const [symbol, expectedFile] of definitions) {
      const matches = files.filter((file) => {
        const source = readFileSync(fileURLToPath(new URL(`../src/${file}`, import.meta.url)), "utf8");
        return new RegExp(`export interface ${symbol}\\b`).test(source);
      });
      assert.deepEqual(matches, [expectedFile], `${symbol} should be defined only in ${expectedFile}`);
    }

    const reviewBarrel = readFileSync(fileURLToPath(new URL("../src/review.ts", import.meta.url)), "utf8");
    assert.doesNotMatch(reviewBarrel, /export interface /);
    assert.match(reviewBarrel, /export \* from "\.\/review_item\.js";/);
  });

  it("keeps the root export surface explicit and canonical", () => {
    const indexTypes = readFileSync(fileURLToPath(new URL("../dist/index.d.ts", import.meta.url)), "utf8");
    assert.doesNotMatch(indexTypes, /export \* from "\.\/review\.js"/);
    assert.match(indexTypes, /from "\.\/review_item\.js"/);
    assert.match(indexTypes, /from "\.\/review_forge\.js"/);
    assert.match(indexTypes, /from "\.\/review_participant\.js"/);

    for (const symbol of [
      "normalizeWorkItem",
      "createActionPlan",
      "normalizeReviewItem",
      "normalizeReviewFinding",
      "resolveReviewParticipants"
    ]) {
      assert.equal(typeof core[symbol], "function", `${symbol} should be exported as a runtime function`);
    }
    assert.equal(typeof core.githubAdapterContract, "object");
    assert.equal(typeof core.opencodeAdapterContract, "object");
  });
});

function readRepoDoc(relativePath) {
  return readFileSync(fileURLToPath(new URL(`../../../${relativePath}`, import.meta.url)), "utf8");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function markdownTableCellText(value) {
  return value.replaceAll("|", "\\|");
}
