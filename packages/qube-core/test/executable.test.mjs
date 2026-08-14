import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { executableExistsOnPath, probeExecutable, resolveExecutable } from "../dist/index.js";

describe("resolveExecutable", () => {
  it("resolves a Windows .exe and .cmd through PATH and PATHEXT without which", () => {
    const fixture = createWindowsFixture();
    try {
      const exe = resolveExecutable("tool", fixture.options);
      assert.equal(exe.status, "found");
      assertPathEqual(exe.resolvedPath, path.join(fixture.first, "tool.exe"));

      const cmd = resolveExecutable("helper", fixture.options);
      assert.equal(cmd.status, "found");
      assertPathEqual(cmd.resolvedPath, path.join(fixture.first, "helper.cmd"));
      assert.equal(executableExistsOnPath("which", fixture.options), false);
      assert.equal(executableExistsOnPath("where", fixture.options), false);
    } finally {
      fixture.cleanup();
    }
  });

  it("retains POSIX lookup of an executable file on PATH", { skip: process.platform === "win32" }, () => {
    const fixture = createPosixFixture();
    try {
      const found = resolveExecutable("tool", fixture.options);
      assert.equal(found.status, "found");
      assert.equal(found.resolvedPath, path.join(fixture.bin, "tool"));
    } finally {
      fixture.cleanup();
    }
  });

  it("skips a POSIX file that exists but is not executable", { skip: process.platform === "win32" }, () => {
    const fixture = createPosixFixture({ executable: false });
    try {
      const found = resolveExecutable("tool", fixture.options);
      assert.equal(found.status, "missing");
      assert.equal(found.resolvedPath, null);
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps the first match when PATH has duplicate entries", () => {
    const fixture = createWindowsFixture();
    try {
      const second = path.join(fixture.root, "second");
      mkdirSync(second, { recursive: true });
      writeFileSync(path.join(second, "tool.exe"), "later\n");
      const options = {
        ...fixture.options,
        env: {
          ...fixture.options.env,
          PATH: [fixture.first, second, fixture.first].join(";"),
        },
      };
      const found = resolveExecutable("tool", options);
      assertPathEqual(found.resolvedPath, path.join(fixture.first, "tool.exe"));
    } finally {
      fixture.cleanup();
    }
  });

  it("resolves a command from a PATH entry that contains spaces", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "qube-exec-space-"));
    try {
      const bin = path.join(root, "Program Files", "Qube Tools");
      mkdirSync(bin, { recursive: true });
      writeFileSync(path.join(bin, "spaced.exe"), "ok\n");
      const found = resolveExecutable("spaced", {
        platform: "win32",
        pathDelimiter: ";",
        env: { OS: "Windows_NT", PATH: bin, PATHEXT: ".EXE;.CMD" },
      });
      assert.equal(found.status, "found");
      assertPathEqual(found.resolvedPath, path.join(bin, "spaced.exe"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses default PATHEXT when PATHEXT is missing", () => {
    const fixture = createWindowsFixture({ omitPathExt: true });
    try {
      const found = resolveExecutable("tool", fixture.options);
      assert.equal(found.status, "found");
      assertPathEqual(found.resolvedPath, path.join(fixture.first, "tool.exe"));
    } finally {
      fixture.cleanup();
    }
  });

  it("resolves an extensionless command shim after PATHEXT candidates", () => {
    const fixture = createWindowsFixture({ shimOnly: true });
    try {
      const found = resolveExecutable("shim", fixture.options);
      assert.equal(found.status, "found");
      assert.equal(found.resolvedPath, path.join(fixture.first, "shim"));
    } finally {
      fixture.cleanup();
    }
  });

  it("reports missing when the command is absent from PATH", () => {
    const fixture = createWindowsFixture();
    try {
      const found = resolveExecutable("absent", fixture.options);
      assert.equal(found.status, "missing");
      assert.equal(found.reasonCode, "missing");
      assert.equal(found.resolvedPath, null);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects a command name that contains a path separator", () => {
    const found = resolveExecutable("bin/tool", {
      platform: "win32",
      pathDelimiter: ";",
      env: { OS: "Windows_NT", PATH: "C:\\Windows", PATHEXT: ".EXE" },
    });
    assert.equal(found.status, "unresolvable");
    assert.equal(found.reasonCode, "invalid-command");
  });
});

describe("probeExecutable", () => {
  it("reports present-but-failing when a resolved command probe exits nonzero", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "qube-exec-probe-"));
    try {
      const bin = path.join(root, "bin");
      mkdirSync(bin, { recursive: true });
      const windows = process.platform === "win32";
      if (windows) {
        writeFileSync(path.join(bin, "broken.cmd"), "@echo off\r\nexit /b 7\r\n");
      } else {
        writeFileSync(path.join(bin, "broken"), "#!/bin/sh\nexit 7\n");
        chmodSync(path.join(bin, "broken"), 0o755);
      }
      const found = probeExecutable("broken", {
        platform: process.platform,
        pathDelimiter: path.delimiter,
        env: windows
          ? { OS: "Windows_NT", PATH: bin, PATHEXT: ".CMD;.EXE" }
          : { PATH: bin },
        probeArgs: [],
      });
      assert.equal(found.status, "found");
      assert.equal(found.probeStatus, "present-but-failing");
      assert.equal(found.probeExitCode, 7);
      assert.notEqual(found.reasonCode, "missing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not probe a missing command", () => {
    const probed = probeExecutable("absent", {
      platform: "win32",
      pathDelimiter: ";",
      env: { OS: "Windows_NT", PATH: path.join(os.tmpdir(), "empty-qube-path"), PATHEXT: ".EXE" },
    });
    assert.equal(probed.status, "missing");
    assert.equal(probed.probeStatus, "not-probed");
  });
});

function assertPathEqual(actual, expected) {
  assert.equal(path.normalize(String(actual)).toLowerCase(), path.normalize(expected).toLowerCase());
}

function createWindowsFixture(options = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "qube-exec-win-"));
  const first = path.join(root, "first");
  mkdirSync(first, { recursive: true });
  if (!options.shimOnly) {
    writeFileSync(path.join(first, "tool.exe"), "exe\n");
    writeFileSync(path.join(first, "helper.cmd"), "@echo off\r\n");
  }
  if (options.shimOnly) {
    writeFileSync(path.join(first, "shim"), "shim\n");
  }
  return {
    root,
    first,
    options: {
      platform: "win32",
      pathDelimiter: ";",
      env: {
        OS: "Windows_NT",
        PATH: first,
        ...(options.omitPathExt ? {} : { PATHEXT: ".EXE;.CMD;.BAT" }),
      },
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function createPosixFixture(options = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "qube-exec-posix-"));
  const bin = path.join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const file = path.join(bin, "tool");
  writeFileSync(file, "#!/bin/sh\necho ok\n");
  if (options.executable !== false) {
    chmodSync(file, 0o755);
  } else {
    chmodSync(file, 0o644);
  }
  return {
    root,
    bin,
    options: {
      platform: "linux",
      pathDelimiter: ":",
      env: { PATH: bin },
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
