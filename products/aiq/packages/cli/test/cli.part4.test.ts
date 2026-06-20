import { describe, expect, it } from "vitest";
import { MemoryInput, MemoryOutput, path, readFile, repoRoot, runCli } from "./cli-test-support.js";
describe("CLI foundation", () => {
  it("renders a QUBE-compatible command schema", async () => {
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "schema", "--format", "json"], {
      cwd: process.cwd(),
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    const schema = JSON.parse(stdout.value) as {
      bin: string;
      commands: Array<{
        name: string;
        dryRun: { supported: boolean };
        extensions?: { aiq?: { capability?: string; contexts?: string[]; targetMode?: string } };
        output: { defaultFormat?: string; formats: string[] };
        supplyChain: { kinds: string[]; sensitive: boolean };
      }>;
      extensions?: {
        aiq?: { defaultCommand?: string; explicitTargetCommand?: string };
        qube?: { discoverable?: boolean };
      };
      package: { name: string; version: string };
      schemaVersion: number;
      sections?: { discovery?: { command?: string; packageExport?: string } };
    };
    const packageJson = JSON.parse(
      await readFile(path.join(repoRoot, "packages", "cli", "package.json"), "utf8"),
    ) as { name: string; version: string };
    const commands = new Map(schema.commands.map((command) => [command.name, command]));

    expect(schema.schemaVersion).toBe(1);
    expect(schema.package).toEqual({ name: packageJson.name, version: packageJson.version });
    expect(schema.bin).toBe("aiq");
    expect(schema.extensions?.qube?.discoverable).toBe(true);
    expect(schema.extensions?.aiq?.defaultCommand).toBe("aiq");
    expect(schema.extensions?.aiq?.explicitTargetCommand).toBe("aiq run <paths...>");
    expect(schema.sections?.discovery).toEqual({
      command: "aiq schema --format json",
      packageExport: "@tjalve/aiq/schema",
    });
    expect([...commands.keys()]).toEqual([
      "bench",
      "ci",
      "config",
      "doctor",
      "evidence",
      "hook",
      "ignore",
      "plan",
      "run",
      "schema",
      "serve",
      "setup",
      "status",
      "watch",
    ]);
    expect(commands.get("run")?.extensions?.aiq?.capability).toBe("quality-control");
    expect(commands.get("run")?.extensions?.aiq?.contexts).toContain("qube");
    expect(commands.get("run")?.extensions?.aiq?.targetMode).toBe("explicit-paths");
    expect(commands.get("run")?.dryRun.supported).toBe(true);
    expect(commands.get("run")?.supplyChain).toMatchObject({
      kinds: ["dependency", "package-manager"],
      sensitive: true,
    });
    expect(commands.get("setup")?.extensions?.aiq?.capability).toBe("quality-setup");
    expect(commands.get("schema")?.output).toEqual({
      defaultFormat: "json",
      formats: ["json"],
    });
    expect(commands.get("evidence")?.output).toEqual({
      defaultFormat: "json",
      formats: ["json"],
    });
    expect(commands.get("bench")?.extensions?.aiq?.contexts).toEqual(["standalone"]);
    expect(commands.get("watch")?.extensions?.aiq?.contexts).toEqual(["standalone"]);
    expect(commands.get("serve")?.extensions?.aiq?.contexts).toEqual(["standalone"]);
  });

  it("rejects text output for JSON-only commands", async () => {
    for (const [args, message] of [
      [
        ["node", "aiq", "schema", "--format", "text"],
        "The schema command only supports --format json.",
      ],
      [
        ["node", "aiq", "schema", "--format", "text", "--format", "json"],
        "The schema command only supports --format json.",
      ],
      [
        ["node", "aiq", "evidence", "--format", "text"],
        "The evidence command only supports --format json.",
      ],
      [
        ["node", "aiq", "evidence", "--format", "text", "--format", "json"],
        "The evidence command only supports --format json.",
      ],
    ] as const) {
      const stdout = new MemoryOutput();
      const stderr = new MemoryOutput();

      const exitCode = await runCli(args, {
        cwd: process.cwd(),
        stderr,
        stdin: new MemoryInput(),
        stdout,
      });

      expect(exitCode).toBe(2);
      expect(stdout.value).toBe("");
      expect(stderr.value).toContain(message);
    }
  });
});
