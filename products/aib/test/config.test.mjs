import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { AibConfigLayerError, loadAibConfig } from "../dist/config.js";

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

test("AIB resolves user-global, repository, and machine-local fields independently", () => {
  const repo = mkdtempSync(join(tmpdir(), "aib-layer-repo-"));
  const home = mkdtempSync(join(tmpdir(), "aib-layer-home-"));
  mkdirSync(join(home, ".qube", "aib"), { recursive: true });
  writeJson(join(home, ".qube", "aib", "config.json"), {
    version: 1,
    agent: { host: "codex", questionBudget: 5 },
    safety: { allowNetwork: true },
  });
  writeJson(join(repo, "aib.config.json"), {
    version: 1,
    agent: { questionBudget: 2 },
    safety: { allowNetwork: false },
  });
  writeJson(join(repo, "aib.config.local.json"), {
    version: 1,
    paths: { docsDir: "machine-docs" },
  });

  const loaded = loadAibConfig(undefined, { startDir: repo, homeDirectory: home });

  assert.equal(loaded.config.agent.host, "codex");
  assert.equal(loaded.config.agent.questionBudget, 2);
  assert.equal(loaded.config.safety.allowNetwork, false);
  assert.equal(loaded.config.paths.docsDir, "machine-docs");
  assert.equal(loaded.fieldSources["agent.host"], "user-global");
  assert.equal(loaded.fieldSources["agent.questionBudget"], "repository");
  assert.equal(loaded.fieldSources["paths.docsDir"], "machine-local");
  assert.equal(loaded.fieldSources["paths.stateDir"], "default");
  assert.equal(loaded.layers.repository.safety.allowNetwork, false);
  assert.equal(loaded.layers.machineLocal.paths.docsDir, "machine-docs");
});

test("AIB accepts absent repository config and applies changed global values immediately", () => {
  const repo = mkdtempSync(join(tmpdir(), "aib-global-repo-"));
  const home = mkdtempSync(join(tmpdir(), "aib-global-home-"));
  const globalPath = join(home, ".qube", "aib", "config.json");
  mkdirSync(join(home, ".qube", "aib"), { recursive: true });
  writeJson(globalPath, { version: 1, agent: { questionBudget: 4 } });
  assert.equal(loadAibConfig(undefined, { startDir: repo, homeDirectory: home }).config.agent.questionBudget, 4);

  writeJson(globalPath, { version: 1, agent: { questionBudget: 6 } });
  const changed = loadAibConfig(undefined, { startDir: repo, homeDirectory: home });
  assert.equal(changed.config.agent.questionBudget, 6);
  assert.equal(changed.fieldSources["agent.questionBudget"], "user-global");
  assert.equal(changed.layers.repository, null);
});

test("AIB validates each partial layer before merge and reports its exact scope", () => {
  const repo = mkdtempSync(join(tmpdir(), "aib-invalid-repo-"));
  const home = mkdtempSync(join(tmpdir(), "aib-invalid-home-"));
  mkdirSync(join(home, ".qube", "aib"), { recursive: true });
  writeJson(join(home, ".qube", "aib", "config.json"), { version: 1, safety: { allowNetwork: "yes" } });
  writeJson(join(repo, "aib.config.json"), { version: 1, safety: { allowNetwork: false } });

  assert.throws(
    () => loadAibConfig(undefined, { startDir: repo, homeDirectory: home }),
    (error) => error instanceof AibConfigLayerError
      && error.scope === "user-global"
      && error.path.endsWith(".qube\\aib\\config.json")
      && error.field === "safety.allowNetwork"
      && error.reason.includes("must be a boolean")
      && error.nextAction.includes("rerun"),
  );
});

test("AIB rejects unknown fields in a repository layer", () => {
  const repo = mkdtempSync(join(tmpdir(), "aib-unknown-repo-"));
  const home = mkdtempSync(join(tmpdir(), "aib-unknown-home-"));
  writeJson(join(repo, "aib.config.json"), { version: 1, agent: { hiddenChoice: true } });

  assert.throws(
    () => loadAibConfig(undefined, { startDir: repo, homeDirectory: home }),
    (error) => error instanceof AibConfigLayerError
      && error.scope === "repository"
      && error.field === "agent.hiddenChoice",
  );
});
