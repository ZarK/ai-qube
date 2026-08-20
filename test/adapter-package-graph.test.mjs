import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const ADAPTER_NAME = /@tjalve\/qube-adapter-/;
const PRODUCT_ADAPTERS = new Map([
  ["products/aie/package.json", [
    "@tjalve/qube-adapter-claude-code",
    "@tjalve/qube-adapter-codex",
    "@tjalve/qube-adapter-cursor",
    "@tjalve/qube-adapter-grok-build",
    "@tjalve/qube-adapter-opencode",
  ]],
  ["products/aiu/package.json", [
    "@tjalve/qube-adapter-claude-code",
    "@tjalve/qube-adapter-codex",
    "@tjalve/qube-adapter-grok-build",
    "@tjalve/qube-adapter-opencode",
  ]],
  ["products/aib/package.json", []],
  ["products/qube/package.json", []],
]);

describe("product adapter package graph", () => {
  it("declares the exact runtime adapters used by each product", () => {
    for (const [relative, expected] of PRODUCT_ADAPTERS) {
      const manifest = JSON.parse(readFileSync(path.join(repoRoot, relative), "utf8"));
      const runtimeAdapters = Object.keys(manifest.dependencies ?? {}).filter(name => ADAPTER_NAME.test(name)).sort();
      const optionalAdapters = Object.keys(manifest.optionalDependencies ?? {}).filter(name => ADAPTER_NAME.test(name)).sort();
      assert.deepEqual(runtimeAdapters, [...expected].sort(), `${relative} must declare its exact runtime adapter set`);
      assert.deepEqual(optionalAdapters, [], `${relative} must not make required adapters optional`);
    }
  });
});
