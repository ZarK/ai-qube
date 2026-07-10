import assert from "node:assert/strict";

import type { QubeAdapterContract } from "@tjalve/qube-core";

import {
  declarationMap,
  isSupported,
  isUnsupported,
} from "./capabilities.js";
import { createSubject } from "./descriptor.js";
import type { RoleHarness } from "./types.js";

export async function verifyCiRoleSuite(adapter: QubeAdapterContract, harness: RoleHarness): Promise<void> {
  const scenarios = harness.ciScenarios;
  assert.ok(scenarios, "CI provider harness must supply ciScenarios.");
  const subject = await createSubject(harness);
  const declared = declarationMap(adapter);

  if (isSupported(declared, "read-ci-status")) {
    const passed = scenarios.mapCheck(subject, scenarios.passedCheck);
    assert.equal(passed.result, "passed");
    assert.ok(passed.name || passed.key, "CI mapCheck must expose a check name or key for artifact/reference identity.");
    assert.ok(passed.summary && passed.summary.trim().length > 0, "CI mapCheck must expose a summary reference for the check.");
    assert.ok(
      (passed.url && String(passed.url).trim().length > 0)
        || (passed.path && String(passed.path).trim().length > 0)
        || (passed.workflowName && String(passed.workflowName).trim().length > 0)
        || (passed.runId && String(passed.runId).trim().length > 0)
        || (passed.artifact && String(passed.artifact).trim().length > 0),
      "CI mapCheck must expose an artifact/reference field (url, path, workflowName, runId, or artifact).",
    );
  }
  if (isSupported(declared, "diagnose-ci-status")) {
    const failed = scenarios.mapCheck(subject, scenarios.failedCheck);
    const pending = scenarios.mapCheck(subject, scenarios.pendingCheck);
    assert.equal(failed.result, "failed");
    assert.equal(pending.result, "pending");
    assert.ok(failed.reasonCode && failed.reasonCode.trim().length > 0, "diagnose-ci-status failed checks must include reasonCode.");
    assert.ok(failed.summary && failed.summary.trim().length > 0, "diagnose-ci-status failed checks must include summary.");
    assert.ok(pending.reasonCode && pending.reasonCode.trim().length > 0, "diagnose-ci-status pending checks must include reasonCode.");
    assert.ok(pending.summary && pending.summary.trim().length > 0, "diagnose-ci-status pending checks must include summary.");
  }
  if (isUnsupported(declared, "trigger-workflow-run")) {
    assert.ok(scenarios.unsupportedTrigger, "unsupportedTrigger is required when trigger-workflow-run is unsupported.");
    await assert.rejects(async () => {
      await scenarios.unsupportedTrigger!();
    }, /unsupported/i);
  }
  if (isSupported(declared, "trigger-workflow-run")) {
    // Supported triggers must be first-class subject methods with an observable successful result.
    const triggerable = subject as { triggerWorkflowRun?: () => unknown | Promise<unknown> };
    assert.equal(typeof triggerable.triggerWorkflowRun, "function", "supported trigger-workflow-run requires subject.triggerWorkflowRun().");
    const result = await triggerable.triggerWorkflowRun!();
    assert.ok(result && typeof result === "object", "supported triggerWorkflowRun must return an object result.");
    const status = (result as { status?: string }).status;
    assert.ok(
      status === "planned" || status === "completed" || status === "success" || status === "pass",
      "supported triggerWorkflowRun must return a successful status (planned/completed/success/pass).",
    );
  }
}
