import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import * as core from "../dist/index.js";
import {
  findQubeProduct,
  normalizeWorkItem,
  qubeCommandSurfaceContracts,
  qubePathContracts,
  qubeProductContracts,
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
