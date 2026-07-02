import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  GhExecutionError,
  GhMalformedOutputError,
  getIssue,
  listOpenIssues,
  parseDeclaredBlockers,
  parseGhJson,
  runGh,
} from "../dist/index.js";

function success(args, stdout = "") {
  return { args, exitCode: 0, stdout, stderr: "" };
}

describe("GitHub issue API", () => {
  it("runGh uses explicit args and redacts tokens from custom exec results", async () => {
    const exec = async (args, cwd) => ({
      args,
      exitCode: 0,
      stdout: `ok github_pat_1234567890abcdefghijklmnopqrstuvwxyz`,
      stderr: `cwd=${cwd}`,
    });

    const result = await runGh(["issue", "list"], { exec, cwd: "repo" });

    assert.deepEqual(result.args, ["issue", "list"]);
    assert.equal(result.stdout.includes("github_pat_"), false);
    assert.equal(result.stderr, "cwd=repo");
  });

  it("parseGhJson throws a typed malformed-output error on bad JSON", () => {
    assert.throws(() => parseGhJson("not json", "gh test"), GhMalformedOutputError);
  });

  it("listOpenIssues normalizes issues, labels, milestones, and declared blockers", async () => {
    const exec = async (args) => success(args, JSON.stringify([
      {
        number: 42,
        title: "Implement feature",
        body: "Blocked by: #7",
        state: "OPEN",
        labels: [{ name: "S-Ready" }],
        milestone: { number: 3, title: "MVP", state: "OPEN", dueOn: null },
        url: "https://github.com/example/repo/issues/42",
      },
    ]));

    const issues = await listOpenIssues({ exec });

    assert.deepEqual(issues[0].labels, ["S-Ready"]);
    assert.deepEqual(issues[0].declaredBlockers, [7]);
    assert.deepEqual(issues[0].milestone, { number: 3, title: "MVP", state: "OPEN", dueOn: null });
  });

  it("getIssue returns normalized single issue with blockers", async () => {
    const exec = async (args) => success(args, JSON.stringify({
      number: 42,
      title: "Implement feature",
      body: "Blocked by: #7",
      state: "OPEN",
      labels: [],
      assignees: [{ login: "octo" }],
      milestone: null,
      url: "https://github.com/example/repo/issues/42",
    }));

    const issue = await getIssue(42, { exec, includeAssignees: true });

    assert.equal(issue.number, 42);
    assert.deepEqual(issue.assignees, ["octo"]);
    assert.deepEqual(issue.declaredBlockers, [7]);
  });

  it("parseDeclaredBlockers extracts line-based blockers only", () => {
    const body = [
      "Blocked by: #10",
      "- Blocked by: #11 #13",
      "Blocked by: #14, #15",
      "Text Blocked by: #12",
      "Blocked by: not-a-number",
      "Blocked by: #10",
    ].join("\n");

    assert.deepEqual(parseDeclaredBlockers(body), [10, 11, 13, 14, 15]);
  });

  it("surfaces non-zero custom exec exits as execution errors", async () => {
    const exec = async (args) => ({ args, exitCode: 1, stdout: "", stderr: "permission denied" });

    await assert.rejects(
      () => listOpenIssues({ exec }),
      error => error instanceof GhExecutionError && error.exitCode === 1 && error.message.includes("gh issue list"),
    );
  });
});
