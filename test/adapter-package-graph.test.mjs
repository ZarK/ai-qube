import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const ADAPTER_NAME = /@tjalve\/qube-adapter-/;
const PRODUCT_MANIFESTS = [
  "products/aie/package.json",
  "products/aib/package.json",
  "products/qube/package.json",
];

describe("product adapter package graph", () => {
  it("does not pull adapter packages through product dependencies or optionalDependencies", () => {
    for (const relative of PRODUCT_MANIFESTS) {
      const manifest = JSON.parse(readFileSync(path.join(repoRoot, relative), "utf8"));
      for (const field of ["dependencies", "optionalDependencies"]) {
        const declared = Object.keys(manifest[field] ?? {}).filter(name => ADAPTER_NAME.test(name));
        assert.deepEqual(declared, [], `${relative} ${field} must not declare adapter packages`);
      }
    }
  });
});
