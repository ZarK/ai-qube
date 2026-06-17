import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { findQubeProduct, qubeProductContracts } from "../dist/index.js";

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
});
