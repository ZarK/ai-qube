import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  LAYERED_CONFIG_SOURCES,
  QUBE_INIT_LAYER_CONTEXT_ENV,
  projectSparseFieldIds,
  readInitLayerContext,
  resolveLayeredFields,
  sameLayeredValue,
  serializeInitLayerContext,
} from "../dist/index.js";

const fields = Object.freeze([
  Object.freeze({ id: "primary", read: config => config.primary, comparison: "ordered" }),
  Object.freeze({ id: "checks", read: config => config.checks, comparison: "set" }),
  Object.freeze({ id: "enabled", read: config => config.enabled }),
]);

describe("layered configuration", () => {
  it("publishes the stable source vocabulary", () => {
    assert.deepEqual([...LAYERED_CONFIG_SOURCES], [
      "explicit", "machine-local", "repository", "user-global", "detected", "default", "derived",
    ]);
  });

  it("resolves every leaf from the first layer where it is present", () => {
    const resolved = resolveLayeredFields({
      fields,
      layers: [
        { source: "explicit", config: { enabled: false } },
        { source: "machine-local", config: { primary: ["local"] } },
        { source: "repository", config: { checks: [] } },
        { source: "user-global", config: { primary: ["global"], checks: ["unit"] } },
      ],
    });
    assert.deepEqual(resolved.values, { primary: ["local"], checks: [], enabled: false });
    assert.deepEqual(resolved.sources, { primary: "machine-local", checks: "repository", enabled: "explicit" });
  });

  it("projects only semantic differences and preserves ordered values", () => {
    const included = projectSparseFieldIds({
      fields,
      desired: { primary: ["second", "first"], checks: ["security", "unit"], enabled: false },
      baseline: { primary: ["first", "second"], checks: ["unit", "security"], enabled: false },
    });
    assert.deepEqual(included, ["primary"]);
    assert.equal(sameLayeredValue([], undefined), false);
    assert.equal(sameLayeredValue(false, undefined), false);
  });

  it("round-trips the shared init layer context and rejects invalid source values", () => {
    const serialized = serializeInitLayerContext({
      version: 1,
      selectedScope: "repository",
      effective: { hosts: ["codex"] },
      sources: { hosts: "user-global" },
      baseline: { version: 1, hosts: ["codex"] },
      repository: { version: 1 },
    });
    assert.deepEqual(readInitLayerContext({ [QUBE_INIT_LAYER_CONTEXT_ENV]: serialized }), {
      version: 1,
      selectedScope: "repository",
      effective: { hosts: ["codex"] },
      sources: { hosts: "user-global" },
      baseline: { version: 1, hosts: ["codex"] },
      repository: { version: 1 },
    });
    assert.throws(
      () => readInitLayerContext({ [QUBE_INIT_LAYER_CONTEXT_ENV]: JSON.stringify({
        version: 1,
        selectedScope: "repository",
        effective: {},
        sources: { hosts: "caller-selected" },
        baseline: null,
        repository: null,
      }) }),
      /source for hosts is not supported/,
    );
  });
});
