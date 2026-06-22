import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  findQubeProduct,
  normalizeWorkItem,
  qubeCommandSurfaceContracts,
  qubePathContracts,
  qubeProductContracts,
  qubeRepoArtifactContracts
} from "../dist/index.js";

describe("qube core contracts", () => {
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

    assert.deepEqual(surfaces.get("bootstrap"), ["cli", "github", "gitlab", "linear", "codex", "opencode", "claude-code"]);
    assert.deepEqual(surfaces.get("executor"), ["cli", "github", "gitlab", "linear", "codex", "opencode", "claude-code"]);
    assert.deepEqual(surfaces.get("quality"), ["cli"]);
    assert.deepEqual(surfaces.get("umpire"), ["cli", "opencode", "claude-code"]);
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
