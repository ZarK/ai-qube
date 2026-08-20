import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  configForQubeScope,
  parseQubeInitConfig,
  readInitRecord,
  readQubeInitConfig,
  repoQubeConfigPath,
  resolveQubeInitConfig,
  userQubeConfigPath,
  writeQubeInitConfig,
} from "../dist/index.js";

const defaults = Object.freeze({
  version: 1,
  hosts: Object.freeze(["codex"]),
  workProviders: Object.freeze(["github"]),
  ciProviders: Object.freeze(["github"]),
  continuousShipping: true,
  umpire: Object.freeze({ scope: "ready" }),
  quality: Object.freeze({ stages: Object.freeze(["unit"]) }),
  review: Object.freeze({
    mode: "host",
    harness: "codex",
    externalReviewers: Object.freeze(["coderabbit"]),
    publisher: "user",
  }),
  mcp: Object.freeze({ optIn: false }),
});

describe("QUBE init configuration", () => {
  it("resolves explicit, repository, global, detected, and default values in order", () => {
    const resolved = resolveQubeInitConfig({
      defaults,
      globalConfig: {
        version: 1,
        hosts: ["claude-code"],
        workProviders: ["gitlab"],
        continuousShipping: false,
        umpire: { scope: "standard" },
      },
      repoConfig: {
        version: 1,
        hosts: ["opencode"],
        quality: { stages: ["lint", "security"] },
      },
      detected: { version: 1, ciProviders: ["jenkins"] },
      explicit: { version: 1, review: { mode: "external", publisher: "github-app" } },
    });

    assert.deepEqual(resolved.config.hosts, ["opencode"]);
    assert.deepEqual(resolved.config.workProviders, ["gitlab"]);
    assert.deepEqual(resolved.config.ciProviders, ["jenkins"]);
    assert.equal(resolved.config.continuousShipping, false);
    assert.equal(resolved.config.umpire.scope, "standard");
    assert.deepEqual(resolved.config.quality.stages, ["lint", "security"]);
    assert.equal(resolved.config.review.mode, "external");
    assert.deepEqual(resolved.config.review.externalReviewers, ["coderabbit"]);
    assert.equal(resolved.config.review.publisher, "github-app");
    assert.equal(resolved.sources.hosts, "repo");
    assert.equal(resolved.sources.workProviders, "global");
    assert.equal(resolved.sources.ciProviders, "detected");
    assert.equal(resolved.sources["review.publisher"], "explicit");
  });

  it("does not copy inherited global values into repository configuration", () => {
    const globalConfig = {
      version: 1,
      hosts: ["claude-code"],
      workProviders: ["github"],
      continuousShipping: true,
      umpire: { scope: "ready" },
      review: { mode: "external", externalReviewers: ["coderabbit"], publisher: "user" },
    };
    const resolved = resolveQubeInitConfig({
      defaults,
      globalConfig,
      repoConfig: { version: 1, quality: { stages: ["security"] } },
      detected: { version: 1, ciProviders: ["github"] },
    });

    assert.deepEqual(configForQubeScope(resolved, "repo"), {
      version: 1,
      ciProviders: ["github"],
      quality: { stages: ["security"] },
      mcp: { optIn: false },
    });
  });

  it("falls through to default reviewers when a higher scope switches review mode", () => {
    const resolved = resolveQubeInitConfig({
      defaults,
      globalConfig: { version: 1, review: { mode: "host", publisher: "user" } },
      repoConfig: { version: 1, review: { mode: "external" } },
    });

    assert.equal(resolved.config.review.mode, "external");
    assert.deepEqual(resolved.config.review.externalReviewers, ["coderabbit"]);
    assert.equal(resolved.sources["review.mode"], "repo");
    assert.equal(resolved.sources["review.externalReviewers"], "default");
  });

  it("derives a global host-review harness without seeding it into the repository", () => {
    const globalConfig = {
      version: 1,
      hosts: ["claude-code"],
      review: { mode: "host", publisher: "user" },
    };
    const resolved = resolveQubeInitConfig({
      defaults,
      globalConfig,
      repoConfig: { version: 1 },
    });

    assert.equal(resolved.config.review.harness, "claude-code");
    assert.equal(resolved.sources.hosts, "global");
    assert.equal(resolved.sources["review.harness"], "global");
    const repoConfig = configForQubeScope(resolved, "repo");
    assert.equal(Object.hasOwn(repoConfig, "hosts"), false);
    assert.equal(Object.hasOwn(repoConfig, "review"), false);
  });

  it("keeps a repository-derived host-review harness out of global config", () => {
    const globalConfig = {
      version: 1,
      hosts: ["claude-code"],
      review: { mode: "host", publisher: "user" },
    };
    const resolved = resolveQubeInitConfig({
      defaults,
      globalConfig,
      repoConfig: { version: 1, hosts: ["codex"] },
    });

    assert.equal(resolved.config.review.harness, "codex");
    assert.equal(resolved.sources.hosts, "repo");
    assert.equal(resolved.sources["review.harness"], "derived");
    assert.equal(Object.hasOwn(configForQubeScope(resolved, "repo"), "review"), false);
    const nextGlobal = configForQubeScope(resolved, "global", globalConfig);
    assert.deepEqual(nextGlobal.hosts, ["claude-code"]);
    assert.equal(Object.hasOwn(nextGlobal.review, "harness"), false);
  });

  it("keeps repository-derived review defaults out of global config", () => {
    const multiHostDefaults = {
      ...defaults,
      review: {
        mode: "isolated",
        harness: "grok-build",
        externalReviewers: ["coderabbit"],
        publisher: "user",
      },
    };
    const firstRepo = resolveQubeInitConfig({
      defaults: multiHostDefaults,
      globalConfig: null,
      repoConfig: { version: 1, hosts: ["codex", "grok-build"] },
    });

    assert.equal(firstRepo.config.review.mode, "isolated");
    assert.equal(firstRepo.config.review.harness, "grok-build");
    assert.equal(firstRepo.sources["review.mode"], "repo");
    assert.equal(firstRepo.sources["review.harness"], "repo");
    assert.equal(firstRepo.sources["review.externalReviewers"], "repo");

    const globalConfig = configForQubeScope(firstRepo, "global");
    assert.equal(Object.hasOwn(globalConfig, "hosts"), false);
    assert.equal(Object.hasOwn(globalConfig.review, "mode"), false);
    assert.equal(Object.hasOwn(globalConfig.review, "harness"), false);
    assert.equal(Object.hasOwn(globalConfig.review, "externalReviewers"), false);

    const singleHostDefaults = {
      ...defaults,
      review: {
        mode: "host",
        harness: "codex",
        externalReviewers: ["coderabbit"],
        publisher: "user",
      },
    };
    const secondRepo = resolveQubeInitConfig({
      defaults: singleHostDefaults,
      globalConfig,
      repoConfig: { version: 1, hosts: ["codex"] },
    });

    assert.equal(secondRepo.config.review.mode, "host");
    assert.equal(secondRepo.config.review.harness, "codex");
    assert.equal(secondRepo.sources["review.mode"], "repo");
    assert.equal(secondRepo.sources["review.harness"], "repo");
  });

  it("removes review fields that conflict with an explicit global mode change", () => {
    const hostGlobal = {
      version: 1,
      hosts: ["codex"],
      review: { mode: "host", harness: "codex", publisher: "user" },
    };
    const external = resolveQubeInitConfig({
      defaults,
      globalConfig: hostGlobal,
      explicit: {
        version: 1,
        review: { mode: "external", externalReviewers: ["coderabbit"] },
      },
    });
    const externalGlobal = configForQubeScope(external, "global", hostGlobal);
    assert.equal(externalGlobal.review.mode, "external");
    assert.deepEqual(externalGlobal.review.externalReviewers, ["coderabbit"]);
    assert.equal(Object.hasOwn(externalGlobal.review, "harness"), false);

    const previousExternal = {
      version: 1,
      hosts: ["codex"],
      review: { mode: "external", externalReviewers: ["coderabbit"], publisher: "user" },
    };
    const host = resolveQubeInitConfig({
      defaults,
      globalConfig: previousExternal,
      explicit: { version: 1, review: { mode: "host" } },
    });
    const nextHostGlobal = configForQubeScope(host, "global", previousExternal);
    assert.equal(nextHostGlobal.review.mode, "host");
    assert.equal(Object.hasOwn(nextHostGlobal.review, "externalReviewers"), false);
  });

  it("keeps mixed-scope review selections independent and readable", () => {
    const globalConfig = {
      version: 1,
      hosts: ["codex"],
      review: { mode: "external", externalReviewers: ["coderabbit"], publisher: "user" },
    };
    const repoConfig = { version: 1, review: { mode: "host" } };
    const resolved = resolveQubeInitConfig({ defaults, globalConfig, repoConfig });

    assert.equal(resolved.config.review.mode, "host");
    assert.equal(resolved.config.review.harness, "codex");
    assert.equal(resolved.sources["review.harness"], "derived");

    const nextGlobal = configForQubeScope(resolved, "global", globalConfig);
    assert.deepEqual(nextGlobal.review, globalConfig.review);
    assert.equal(Object.hasOwn(nextGlobal.review, "harness"), false);
    const nextRepo = configForQubeScope(resolved, "repo");
    assert.deepEqual(nextRepo.review, { mode: "host" });

    const cwd = mkdtempSync(path.join(tmpdir(), "qube-init-mixed-repo-"));
    const home = mkdtempSync(path.join(tmpdir(), "qube-init-mixed-home-"));
    writeQubeInitConfig(userQubeConfigPath(home), nextGlobal);
    writeQubeInitConfig(repoQubeConfigPath(cwd), nextRepo);
    const record = readInitRecord(cwd, { USERPROFILE: home, HOME: home });
    assert.ok(record);
    assert.equal(record.review.mode, "host");
    assert.equal(record.review.harness, "codex");
    assert.equal(Object.hasOwn(record.review, "externalReviewers"), false);
  });

  it("writes the current contract once and then reports an exact no-op", () => {
    const root = mkdtempSync(path.join(tmpdir(), "qube-init-config-"));
    const filePath = path.join(root, ".qube", "config.json");
    assert.equal(writeQubeInitConfig(filePath, defaults), "create");
    const first = readFileSync(filePath, "utf8");
    assert.equal(writeQubeInitConfig(filePath, defaults), "skip");
    assert.equal(readFileSync(filePath, "utf8"), first);
    assert.equal(readQubeInitConfig(filePath).status, "valid");
  });

  it("rejects fields outside the current greenfield contract", () => {
    assert.throws(
      () => parseQubeInitConfig({ version: 1, migration: { enabled: true } }),
      /unsupported field: migration/,
    );
  });
});
