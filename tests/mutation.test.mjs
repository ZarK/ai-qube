import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("mutation helpers", () => {
  it("defines mutation categories and dry-run support", async () => {
    const { defineMutationMetadata, dryRunSupported, dryRunUnsupported, mutationCategories } = await import("../dist/index.js");

    assert.deepEqual(mutationCategories("local-files", "dependency"), ["local-files", "dependency"]);
    assert.deepEqual(defineMutationMetadata({ categories: mutationCategories("release") }), { categories: ["release"] });
    assert.deepEqual(dryRunSupported(), { supported: true });
    assert.deepEqual(dryRunUnsupported("External service has no preview API."), {
      supported: false,
      reason: "External service has no preview API."
    });
    assert.throws(() => mutationCategories(), /mutation\.categories must include at least one item/);
  });

  it("renders deterministic dry-run plans and JSON fields", async () => {
    const { createDryRunPlan, createDryRunPlanFields, renderDryRunPlan, renderJsonSuccess } = await import("../dist/index.js");
    const plan = createDryRunPlan({
      command: "cache clear",
      summary: "Remove local cache entries.",
      steps: [
        { action: "delete", target: "cache/a", category: "local-files", description: "Remove entry a." },
        { action: "delete", target: "cache/b", category: "local-files", description: "Remove entry b." }
      ],
      rerunCommand: "fixture cache clear --yes"
    });

    assert.match(renderDryRunPlan(plan), /Dry run plan/);
    assert.match(renderDryRunPlan(plan), /Rerun without --dry-run to apply: fixture cache clear --yes/);
    assert.deepEqual(JSON.parse(renderJsonSuccess("cache clear", createDryRunPlanFields(plan))).dryRunPlan.mutationCategories, ["local-files"]);
  });

  it("renders mutation warnings and supply-chain blocks without policy execution", async () => {
    const { createSupplyChainBlock, createSupplyChainBlockFields, renderMutationWarning, renderSupplyChainBlock } = await import("../dist/index.js");
    const warning = renderMutationWarning({
      command: "cache install",
      categories: ["local-files", "dependency"],
      dryRun: { supported: true },
      supplyChainSensitive: true
    });
    const block = createSupplyChainBlock({
      command: "cache install",
      reason: "Package-manager metadata needs consumer approval.",
      sensitiveKinds: ["package-manager", "dependency"],
      checks: [{ name: "age-gate", status: "blocked", description: "Package version is too new." }],
      suggestedNextAction: "Wait for the age gate or approve according to consumer policy."
    });

    assert.match(warning, /Supply chain sensitive: yes/);
    assert.match(renderSupplyChainBlock(block), /Supply-chain block/);
    assert.deepEqual(createSupplyChainBlockFields(block).supplyChainBlock.sensitiveKinds, ["dependency", "package-manager"]);
  });
});
