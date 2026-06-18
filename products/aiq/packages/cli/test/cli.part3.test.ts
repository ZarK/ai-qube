import { describe, expect, it } from "vitest";
import { MemoryInput, MemoryOutput, runCli } from "./cli-test-support.js";
describe("CLI foundation", () => {
  it("shows help and exits with 0", async () => {
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "--help"], {
      cwd: process.cwd(),
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(stdout.value).toContain("Usage:");
    expect(stdout.value).toContain("aiq [--up-to <0-9>");
    expect(stdout.value).toContain("aiq <files...>");
    expect(stdout.value).toContain("aiq run <files...>");
    expect(stdout.value).toContain(
      "aiq bench [--corpus-root <path>] [--scenario <id>] [--tag <tag>] [--kind <cold|warm|diff-only>]",
    );
    expect(stdout.value).toContain("aiq check <files...>");
    expect(stdout.value).toContain("aiq config [--print-config | --set-stage <0-9>]");
    expect(stdout.value).toContain("aiq doctor");
    expect(stdout.value).toContain("aiq evidence [--format json]");
    expect(stdout.value).toContain("aiq status [--format <json|text>]");
    expect(stdout.value).toContain("aiq setup");
    expect(stdout.value).toContain("aiq schema [--format json]");
    expect(stdout.value).toContain("aiq hook install");
    expect(stdout.value).toContain("aiq ci setup");
    expect(stdout.value).toContain("aiq ignore write");
    expect(stdout.value).toContain("The bare aiq command is the configured project gate.");
    expect(stdout.value).toContain("Run is the explicit target command");
    expect(stdout.value).toContain("Check accepts the same explicit target inputs as run.");
    expect(stdout.value).toContain("Examples:");
    expect(stdout.value).toContain("aiq --format json");
    expect(stdout.value).toContain("aiq config --set-stage 3");
    expect(stdout.value).toContain("aiq run src --up-to 3");
    expect(stdout.value).toContain("aiq evidence --format json");
    expect(stdout.value).toContain("aiq schema --format json");
    expect(stdout.value).toContain("0=e2e 1=lint 2=format 3=typecheck");
    expect(stdout.value).toContain(
      "By default aiq, aiq run, and aiq plan use cumulative ladder stages 0 through .aiq/progress.json current_stage when present",
    );
    expect(stdout.value).toContain("then run aiq for the normal cumulative project workflow");
    expect(stdout.value).toContain("Use aiq run <paths...> for explicit file and subtree checks");
    expect(stdout.value).toContain("--only <0-9>");
    expect(stdout.value).toContain("--diff-only");
    expect(stdout.value).toContain("--dry-run");
    expect(stdout.value).toContain("--print-config");
    expect(stdout.value).toContain("--set-stage <0-9>");
    expect(stdout.value).toContain("--up-to <0-9>");
    expect(stdout.value).toContain("--verbose, -v");
    expect(stdout.value).toContain("aiq config initializes .aiq/aiq.config.json");
    expect(stdout.value).toContain("Default text output is compact");
    expect(stdout.value).toContain("--verbose adds run metadata");
    expect(stdout.value).toContain("--format json keeps the complete machine-readable report");
    expect(stdout.value).toContain("aiq doctor validates config/progress state");
    expect(stdout.value).toContain("aiq setup gives agent-facing setup steps");
    expect(stdout.value).toContain("AIQ uses repository-native tool configs by default");
    expect(stdout.value).toContain("Vitest/Jest, Playwright, Ruff/Radon-compatible Python config");
    expect(stdout.value).toContain("aiq evidence emits structured AIQ quality evidence");
    expect(stdout.value).toContain("aiq status shows the current stage");
    expect(stdout.value).toContain("Metric remediation:");
    expect(stdout.value).toContain("Stages 5-7 enforce SLOC, complexity, maintainability");
    expect(stdout.value).toContain(
      "Treat metric remediation as behavior-preserving work, not architecture redesign.",
    );
    expect(stdout.value).toContain("Preserve public APIs, command behavior, tool selection");
    expect(stdout.value).toContain(
      "Do not use metric failures as authorization for feature changes",
    );
    expect(stdout.value).toContain("Use direct purpose-revealing names");
    expect(stdout.value).toContain("no vague helper/manager/processor names");
    expect(stdout.value).toContain("@tjalve/aiq/api exports the model, config, engine");
    expect(stdout.value).toContain("aiq schema --format json expose QUBE-compatible");
    expect(stdout.value).toContain("aiq watch <files...>");
    expect(stdout.value).toContain("aiq serve [--host <host>] [--port <port>]");
  });

  it("shows the same command contract from aiq run --help", async () => {
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "run", "--help"], {
      cwd: process.cwd(),
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(stdout.value).toContain("aiq run <files...>");
    expect(stdout.value).toContain("Examples:");
    expect(stdout.value).toContain("Stage ladder:");
    expect(stdout.value).toContain("--stage <name> is the advanced named-stage form");
    expect(stdout.value).toContain("--up-to N runs every ladder stage from 0 through N.");
  });
});
