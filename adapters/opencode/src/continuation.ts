import {
  CONTINUATION_ADAPTER_VERSION,
  CONTINUATION_DECLARATION_VERSION,
  defineContinuationAdapter,
  defineContinuationDeclaration,
  mergeDedicatedContinuationAsset,
  probeContinuationSurface,
  validateDedicatedContinuationAsset,
  type ContinuationAssetMerge,
  type ContinuationAssetValidation,
  type ContinuationRenderedAsset,
} from "@tjalve/qube-core";

const pluginAsset = Object.freeze({
  id: "plugin-wrapper",
  relativePath: ".opencode/plugins/ai-umpire-continuation.ts",
  description: "OpenCode AI Umpire plugin wrapper.",
  ownership: "dedicated" as const,
  role: "entrypoint" as const,
});

const packageAsset = Object.freeze({
  id: "package-dependency",
  relativePath: ".opencode/package.json",
  description: "OpenCode project plugin package manifest.",
  ownership: "shared" as const,
  role: "configuration" as const,
});

export const opencodeContinuationDeclaration = defineContinuationDeclaration({
  version: CONTINUATION_DECLARATION_VERSION,
  hostId: "opencode",
  nativeSurfaces: Object.freeze([Object.freeze({ id: "plugin-event", minimumVersion: "1.18.25", maximumVersionExclusive: null })]),
  triggerEvents: Object.freeze(["session.idle", "session.status", "idle", "session-idle", "session-status"]),
  delivery: Object.freeze({ method: "host-command", sessionScope: "selected-session" }),
  umpireModes: Object.freeze(["continue", "repair", "wait", "stop"]),
  trust: Object.freeze({ repositoryRequired: true, description: "OpenCode must trust and load the repository plugin." }),
  managedAssets: Object.freeze([pluginAsset, packageAsset]),
  activationEvidence: Object.freeze({ event: "plugin-event", delivery: "host", requiresSessionId: true }),
  currentIssueRecovery: true,
});

export const opencodeContinuationAdapter = defineContinuationAdapter({
  version: CONTINUATION_ADAPTER_VERSION,
  declaration: opencodeContinuationDeclaration,
  renderManagedAssets(context) {
    const version = context.packageVersions["@tjalve/aiu"];
    if (!version) throw new TypeError("OpenCode continuation assets require an exact @tjalve/aiu package version.");
    return Object.freeze([
      Object.freeze({
        ...pluginAsset,
        content: [
          "// Managed by @tjalve/aiu.",
          "// Compose custom behavior outside this package-managed file.",
          "import { createAiuOpenCodeServerPlugin } from \"@tjalve/aiu/opencode\";",
          "",
          "export const AiuUmpireContinuation = createAiuOpenCodeServerPlugin();",
          "",
        ].join("\n"),
      }),
      Object.freeze({ ...packageAsset, content: stableJson({ dependencies: { "@tjalve/aiu": version } }) }),
    ]);
  },
  validateManagedAsset: validateOpenCodeAsset,
  mergeManagedAsset(assetId, existing, desired) {
    if (assetId === pluginAsset.id) return mergeDedicatedContinuationAsset(existing, desired);
    if (assetId !== packageAsset.id) return failedUnknownAsset(assetId);
    const current = validateOpenCodeAsset(assetId, existing, desired);
    if (current.state === "malformed") return Object.freeze({ ok: false, reason: current.reason, validation: current });
    const parsed = parseJsonObject(existing);
    if (!parsed.ok) return Object.freeze({ ok: false, reason: current.reason, validation: current });
    if (parsed.value.dependencies !== undefined && !isRecord(parsed.value.dependencies)) {
      const malformed = validation("malformed", "Existing OpenCode dependencies value is not a JSON object. QUBE will not replace the shared file.");
      return Object.freeze({ ok: false, reason: malformed.reason, validation: malformed });
    }
    const content = stableJson({
      ...parsed.value,
      dependencies: { ...(isRecord(parsed.value.dependencies) ? parsed.value.dependencies : {}), "@tjalve/aiu": expectedVersion(desired) },
    });
    return Object.freeze({ ok: true, content, changed: stableJson(parsed.value) !== content, validation: current });
  },
  decodeEvent(input) {
    if (!isRecord(input)) return Object.freeze({ ok: false, code: "malformed-event", error: "OpenCode event must be an object." });
    const native = isRecord(input.event) ? input.event : input;
    const rawType = typeof native.type === "string" ? native.type : "";
    const type = rawType === "idle" || rawType === "session-idle" ? "session.idle" : rawType === "session-status" ? "session.status" : rawType;
    const properties = isRecord(native.properties) ? native.properties : isRecord(input.payload) ? input.payload : {};
    if (type !== "session.idle" && type !== "session.status") {
      return Object.freeze({ ok: false, code: "unsupported-event", error: `Unsupported OpenCode continuation event: ${type || "unknown"}.` });
    }
    const session = isRecord(properties.session) ? properties.session : {};
    const selectedSession = isRecord(properties.selectedSession) ? properties.selectedSession : {};
    const sessionId = readString(properties.sessionID) ?? readString(properties.sessionId) ?? readString(session.id) ?? readString(properties.id);
    const selectedSessionId = readString(properties.selectedSessionID) ?? readString(properties.selectedSessionId) ?? readString(selectedSession.id) ?? readString(properties.currentSessionId);
    const suppressions: string[] = [];
    const status = readStatus(properties.status) ?? readStatus(session.status);
    const helperRole = readString(session.role);
    const helperSession = readBoolean(properties.helperSession) ?? readBoolean(properties.isHelperSession) ?? readBoolean(session.helper) ?? (helperRole ? helperRole === "helper" : undefined);
    const userActive = readBoolean(properties.userActive) ?? readBoolean(properties.typing) ?? readBoolean(properties.tuiActive);
    const todoActive = readBoolean(properties.todoActive);
    const busy = readBoolean(properties.busy) ?? readBoolean(properties.isBusy) ?? (status ? status !== "idle" : undefined);
    if (helperSession) suppressions.push("helper-session");
    if (busy) suppressions.push("session-busy");
    if (type === "session.status" && status === undefined) suppressions.push("session-status-not-idle");
    if (sessionId && selectedSessionId && sessionId !== selectedSessionId) suppressions.push("selected-session-conflict");
    if (userActive) suppressions.push("user-active");
    if (todoActive) suppressions.push("todo-active");
    const cwd = readString(properties.cwd);
    return Object.freeze({
      ok: true,
      event: Object.freeze({
        event: type,
        ...(sessionId ? { sessionId } : {}),
        ...(selectedSessionId ? { selectedSessionId } : {}),
        ...(cwd ? { cwd } : {}),
        ...(suppressions.length > 0 ? { suppressions: Object.freeze(suppressions) } : {}),
      }),
    });
  },
  encodeResponse(input) {
    if (input.decision !== "deliver" || !input.sessionId || !input.cwd) {
      return Object.freeze({ ok: false, error: "OpenCode delivery requires a selected session id and repository directory." });
    }
    return Object.freeze({
      ok: true,
      response: Object.freeze({
        path: Object.freeze({ id: input.sessionId }),
        body: Object.freeze({ command: "make-it-so", arguments: "" }),
        query: Object.freeze({ directory: input.cwd }),
      }),
    });
  },
  probe(input) {
    const compatibility = probeContinuationSurface(opencodeContinuationDeclaration, input);
    if (compatibility.status === "blocked" || !input.repoRoot) return compatibility;
    return probeOpenCodePackage(input.repoRoot, input.packageVersions?.["@tjalve/aiu"]);
  },
});

function probeOpenCodePackage(repoRoot: string, expectedVersion: string | undefined) {
  const manifestPath = path.join(repoRoot, ...packageAsset.relativePath.split("/"));
  const action = "Run aiu init --tool opencode, install the exact declared package, then rerun aiu doctor --json.";
  if (!existsSync(manifestPath)) return Object.freeze({ status: "blocked" as const, code: "opencode-plugin-package-manifest-missing", reason: "OpenCode cannot load AI Umpire because .opencode/package.json is missing.", path: manifestPath, nextAction: action, severity: "error" as const });
  let manifest: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
    if (!isRecord(parsed)) throw new Error("manifest is not a JSON object");
    manifest = parsed;
  } catch (error) {
    return Object.freeze({ status: "blocked" as const, code: "opencode-plugin-package-manifest-invalid", reason: `OpenCode cannot load AI Umpire because .opencode/package.json is invalid: ${error instanceof Error ? error.message : String(error)}`, path: manifestPath, nextAction: "Fix .opencode/package.json, rerun aiu init --tool opencode, then rerun aiu doctor --json.", severity: "error" as const });
  }
  const dependencies = isRecord(manifest.dependencies) ? manifest.dependencies : undefined;
  if (!expectedVersion || dependencies?.["@tjalve/aiu"] !== expectedVersion) return Object.freeze({ status: "blocked" as const, code: "opencode-plugin-package-version-mismatch", reason: `OpenCode requires the exact @tjalve/aiu package version ${expectedVersion ?? "declared by Umpire"} in .opencode/package.json.`, path: manifestPath, nextAction: action, severity: "error" as const });
  const installed = resolveInstalledAiu(manifestPath);
  if (!installed) return Object.freeze({ status: "blocked" as const, code: "opencode-plugin-package-unresolved", reason: "OpenCode cannot resolve @tjalve/aiu/opencode from its project package manifest.", path: manifestPath, nextAction: "Install the exact dependencies declared in .opencode/package.json, then rerun aiu doctor --json.", severity: "error" as const });
  if (installed.version !== expectedVersion) return Object.freeze({ status: "blocked" as const, code: "opencode-plugin-package-installed-version-mismatch", reason: `OpenCode resolved @tjalve/aiu ${installed.version}, but ${expectedVersion} is required.`, path: manifestPath, nextAction: "Install the exact dependencies declared in .opencode/package.json, then rerun aiu doctor --json.", severity: "error" as const });
  return Object.freeze({ status: "ready" as const, code: "opencode-plugin-package-resolved", reason: `OpenCode resolves the exact @tjalve/aiu ${expectedVersion} package entrypoint.`, path: manifestPath, nextAction: "Continue using the package-backed OpenCode plugin." });
}

function resolveInstalledAiu(manifestPath: string): { readonly version: string } | undefined {
  let directory = path.dirname(manifestPath);
  while (true) {
    const packageManifestPath = path.join(directory, "node_modules", "@tjalve", "aiu", "package.json");
    if (existsSync(packageManifestPath)) {
      try {
        const installed = JSON.parse(readFileSync(packageManifestPath, "utf8")) as unknown;
        if (isRecord(installed) && installed.name === "@tjalve/aiu" && typeof installed.version === "string" && isRecord(installed.exports)
          && isRecord(installed.exports["./opencode"]) && typeof installed.exports["./opencode"].import === "string"
          && existsSync(path.resolve(path.dirname(packageManifestPath), installed.exports["./opencode"].import))) return { version: installed.version };
      } catch { return undefined; }
      return undefined;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function validateOpenCodeAsset(assetId: string, existing: string | undefined, desired: ContinuationRenderedAsset): ContinuationAssetValidation {
    if (assetId === pluginAsset.id) return validateDedicatedContinuationAsset(existing, desired);
    if (assetId !== packageAsset.id) return unknownAsset(assetId);
    if (existing === undefined) return validation("missing", "Managed host file is missing.");
    const parsed = parseJsonObject(existing);
    if (!parsed.ok) return validation("malformed", "Existing shared file is not a JSON object. QUBE will not replace it.");
    const dependencies = parsed.value.dependencies;
    if (dependencies === undefined) return validation("missing", "The managed OpenCode package dependency is missing.");
    if (!isRecord(dependencies)) return validation("malformed", "Existing OpenCode dependencies value is not a JSON object. QUBE will not replace the shared file.");
    const expected = expectedVersion(desired);
    const actual = dependencies["@tjalve/aiu"];
    if (actual === undefined) return validation("missing", "The managed OpenCode package dependency is missing.");
    return actual === expected
      ? validation("current", "The managed OpenCode package dependency is canonical.")
      : validation("conflicting", "The managed OpenCode package dependency has a conflicting version.");
}

function expectedVersion(desired: ContinuationRenderedAsset): string {
  const parsed = parseJsonObject(desired.content);
  const dependencies = parsed.ok && isRecord(parsed.value.dependencies) ? parsed.value.dependencies : undefined;
  const version = dependencies?.["@tjalve/aiu"];
  if (typeof version !== "string" || version.length === 0) throw new TypeError("Managed OpenCode asset lacks an exact @tjalve/aiu dependency.");
  return version;
}

function validation(state: ContinuationAssetValidation["state"], reason: string): ContinuationAssetValidation {
  return Object.freeze({ state, reason });
}

function unknownAsset(assetId: string): ContinuationAssetValidation {
  return validation("malformed", `Unknown OpenCode continuation asset: ${assetId}.`);
}

function failedUnknownAsset(assetId: string): ContinuationAssetMerge {
  const result = unknownAsset(assetId);
  return Object.freeze({ ok: false, reason: result.reason, validation: result });
}

function parseJsonObject(content: string): { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false } {
  try {
    const value = JSON.parse(content) as unknown;
    return isRecord(value) ? { ok: true, value } : { ok: false };
  } catch {
    return { ok: false };
  }
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, sortJson(entry)]));
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readStatus(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  return isRecord(value) ? readString(value.type) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
