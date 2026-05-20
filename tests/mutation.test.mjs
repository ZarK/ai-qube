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
    const fields = createDryRunPlanFields(plan);
    assert.equal(Object.isFrozen(fields.dryRunPlan), true);
    assert.equal(Object.isFrozen(fields.dryRunPlan.steps), true);
    assert.equal(Object.isFrozen(fields.dryRunPlan.steps[0]), true);
  });

  it("renders mutation warnings and supply-chain blocks without policy execution", async () => {
    const { createSupplyChainBlock, createSupplyChainBlockFields, renderMutationWarning, renderSupplyChainBlock } = await import("../dist/index.js");
    const warning = renderMutationWarning({
      command: "cache install",
      categories: ["local-files", "dependency"],
      dryRun: { supported: true }
    });
    const block = createSupplyChainBlock({
      command: "cache install",
      reason: "Package-manager metadata needs consumer approval.",
      sensitiveKinds: ["package-manager", "dependency"],
      checks: [{ name: "age-gate", status: "blocked", description: "Package version is too new." }],
      suggestedNextAction: " "
    });

    assert.match(warning, /Supply chain sensitive: not declared/);
    assert.match(renderSupplyChainBlock(block), /Supply-chain block/);
    assert.match(renderSupplyChainBlock(block), /Review the supply-chain risk and retry only after the consuming package policy allows it/);
    assert.deepEqual(createSupplyChainBlockFields(block).supplyChainBlock.sensitiveKinds, ["dependency", "package-manager"]);
    assert.equal(createSupplyChainBlockFields(block).supplyChainBlock.suggestedNextAction, "Review the supply-chain risk and retry only after the consuming package policy allows it.");
    assert.equal(Object.isFrozen(createSupplyChainBlockFields(block).supplyChainBlock), true);
    assert.equal(Object.isFrozen(createSupplyChainBlockFields(block).supplyChainBlock.checks), true);
  });

  it("freezes nested mutation helper structures", async () => {
    const { createDryRunPlan, createSupplyChainBlock, defineMutationMetadata, mutationCategories } = await import("../dist/index.js");
    const metadata = defineMutationMetadata({ categories: mutationCategories("dependency") });
    const plan = createDryRunPlan({
      command: "cache install",
      summary: "Prepare dependency cache.",
      steps: [{ action: "review", target: "fixture-lockfile", category: "dependency" }]
    });
    const block = createSupplyChainBlock({
      command: "cache install",
      reason: "Needs review.",
      checks: [{ name: "age-gate", status: "blocked", description: "Too new." }]
    });

    assert.equal(Object.isFrozen(metadata.categories), true);
    assert.equal(Object.isFrozen(plan.steps), true);
    assert.equal(Object.isFrozen(plan.steps[0]), true);
    assert.equal(Object.isFrozen(block.checks), true);
    assert.equal(Object.isFrozen(block.checks?.[0]), true);
  });

  it("handles cyclic extension objects when freezing helper inputs", async () => {
    const { createDryRunPlan } = await import("../dist/index.js");
    const extensions = {};
    extensions.self = extensions;

    const plan = createDryRunPlan({
      command: "cache install",
      summary: "Prepare dependency cache.",
      steps: [{ action: "review", target: "fixture-lockfile", extensions }]
    });

    assert.equal(Object.isFrozen(plan), true);
    assert.equal(Object.isFrozen(plan.steps[0].extensions), true);
    assert.equal(plan.steps[0].extensions.self, plan.steps[0].extensions);
  });

  it("deep-freezes nested values from a frozen root input", async () => {
    const { createDryRunPlan } = await import("../dist/index.js");
    const extensions = { flag: true };
    extensions.self = extensions;
    const input = Object.freeze({
      command: "cache install",
      summary: "Prepare dependency cache.",
      steps: [{ action: "review", target: "fixture-lockfile", extensions }]
    });

    const plan = createDryRunPlan(input);

    assert.equal(Object.isFrozen(plan), true);
    assert.equal(Object.isFrozen(plan.steps), true);
    assert.equal(Object.isFrozen(plan.steps[0]), true);
    assert.equal(Object.isFrozen(plan.steps[0].extensions), true);
    assert.equal(plan.steps[0].extensions.self, plan.steps[0].extensions);
  });
});
