import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  assertOpenCodeOperationSupported,
  getOpenCodeOperationSupport,
  inspectOpenCodeWorkspace,
  listOpenCodeOperationSupport,
  opencodeAdapter,
  opencodeSessionTarget,
} from "../dist/index.js";

const tempDirs = new Set();

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("opencode adapter contract", () => {
  it("exposes a real OpenCode capability map", () => {
    assert.equal(opencodeAdapter.id, "opencode");
    assert.equal(opencodeAdapter.contractOnly, false);
    assert.ok(opencodeAdapter.owns.includes("stop-hooks"));
    assert.ok(opencodeAdapter.owns.includes("unsupported-capability-reporting"));
    assert.match(opencodeAdapter.boundary, /explicit capability records/);
    assert.ok(opencodeAdapter.capabilities?.some((capability) => capability.id === "install-project-command" && capability.support === "supported"));
    assert.ok(opencodeAdapter.capabilities?.some((capability) => capability.id === "run-aiq-plugin" && capability.support === "standalone"));
  });

  it("reports supported and unsupported operations without mock success", () => {
    const commandInstall = getOpenCodeOperationSupport("install-project-command");
    assert.equal(commandInstall.support, "supported");
    assert.match(commandInstall.nextAction, /qube aie init/);

    const aiqPlugin = assertOpenCodeOperationSupported("run-aiq-plugin");
    assert.equal(aiqPlugin.support, "standalone");

    const review = getOpenCodeOperationSupport("request-external-review");
    assert.equal(review.support, "unsupported");
    assert.match(review.nextAction, /review gate/);
    assert.throws(() => assertOpenCodeOperationSupported("request-external-review"), /Unsupported OpenCode capability/);

    const unknown = getOpenCodeOperationSupport("launch-space-elevator");
    assert.equal(unknown.support, "unsupported");
    assert.match(unknown.summary, /No product package has registered real OpenCode behavior/);
    assert.ok(listOpenCodeOperationSupport().length >= 8);
  });

  it("returns immutable operation descriptors", () => {
    const operations = listOpenCodeOperationSupport();
    assert.throws(() => operations.push(operations[0]), TypeError);
    assert.throws(() => {
      operations[0].summary = "mutated";
    }, TypeError);

    const detect = getOpenCodeOperationSupport("detect-host");
    assert.throws(() => detect.paths.push("mutated"), TypeError);

    assert.throws(() => {
      opencodeAdapter.capabilities[0].summary = "mutated";
    }, TypeError);
  });

  it("discovers installed OpenCode instruction and command assets", () => {
    const repo = makeRepo("qube-opencode-adapter-");
    writeFileSync(path.join(repo, "AGENTS.md"), "OpenCode instructions\n");
    mkdirSync(path.join(repo, ".opencode", "commands"), { recursive: true });
    writeFileSync(path.join(repo, ".opencode", "commands", "make-it-so.md"), "Run QUBE\n");
    writeFileSync(path.join(repo, ".opencode", "commands", "custom.md"), "Run custom command\n");

    const inspected = inspectOpenCodeWorkspace(repo);

    assert.equal(inspected.cwd, repo);
    assert.equal(inspected.instructionTarget.present, true);
    assert.equal(inspected.commandDirectory.present, true);
    assert.deepEqual(inspected.commands.map((command) => command.name), ["custom.md", "make-it-so.md"]);
    assert.equal(inspected.commands.find((command) => command.name === "make-it-so.md")?.known, true);
    assert.equal(inspected.commands.find((command) => command.name === "custom.md")?.known, false);
    assert.ok(inspected.capabilities.some((capability) => capability.id === "use-todos"));
    assert.throws(() => inspected.capabilities.push(inspected.capabilities[0]), TypeError);
    assert.throws(() => {
      inspected.capabilities[0].summary = "mutated";
    }, TypeError);
  });

  it("keeps OpenCode session targets normalized", () => {
    assert.equal(opencodeSessionTarget("ses_123"), "opencode:ses_123");
    assert.throws(() => opencodeSessionTarget(" ses_123"), /already normalized/);
  });
});

function makeRepo(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}
