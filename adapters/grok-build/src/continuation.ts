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
} from "@tjalve/qube-core";

import { grokBuildStopHookFile, isGrokSessionEndReason, parseGrokStopPayload } from "./stop_hook.js";

const hookAsset = Object.freeze({ id: "stop-hook", relativePath: grokBuildStopHookFile.relativePath, description: grokBuildStopHookFile.description, ownership: "dedicated" as const, role: "entrypoint" as const });

export const grokBuildContinuationDeclaration = defineContinuationDeclaration({
  version: CONTINUATION_DECLARATION_VERSION,
  hostId: "grok-build",
  nativeSurfaces: Object.freeze([Object.freeze({ id: "stop-hook", minimumVersion: null, maximumVersionExclusive: null })]),
  triggerEvents: Object.freeze(["stop"]),
  delivery: Object.freeze({ method: "stdout-json", sessionScope: "current-session" }),
  umpireModes: Object.freeze(["continue", "repair", "stop"]),
  trust: Object.freeze({ repositoryRequired: true, description: "Grok Build must trust the project Stop hook." }),
  managedAssets: Object.freeze([hookAsset]),
  activationEvidence: Object.freeze({ event: "stop-hook", delivery: "stdout", requiresSessionId: true }),
  currentIssueRecovery: true,
});

export const grokBuildContinuationAdapter = defineContinuationAdapter({
  version: CONTINUATION_ADAPTER_VERSION,
  declaration: grokBuildContinuationDeclaration,
  renderManagedAssets() { return Object.freeze([Object.freeze({ ...hookAsset, content: grokBuildStopHookFile.content })]); },
  validateManagedAsset(assetId, existing, desired) { return assetId === hookAsset.id ? validateDedicatedContinuationAsset(existing, desired) : unknownAsset(assetId); },
  mergeManagedAsset(assetId, existing, desired) { return assetId === hookAsset.id ? mergeDedicatedContinuationAsset(existing, desired) : failedUnknownAsset(assetId); },
  decodeEvent(input) {
    if (!isRecord(input)) return Object.freeze({ ok: false, code: "malformed-event", error: "Grok Build Stop input must be a JSON object." });
    const parsed = parseGrokStopPayload(input);
    if (!parsed.ok) return Object.freeze({ ok: false, code: "malformed-event", error: parsed.error });
    return Object.freeze({ ok: true, event: Object.freeze({
      event: "stop", cwd: parsed.payload.cwd, sessionId: parsed.payload.session_id,
      stopHookActive: parsed.payload.stop_hook_active,
      sessionEnd: isGrokSessionEndReason(parsed.payload.reason),
    }) });
  },
  encodeResponse(input) {
    if (input.decision === "allow") return Object.freeze({ ok: true, response: Object.freeze({}) });
    if (input.decision !== "block" || !input.prompt?.trim()) return Object.freeze({ ok: false, error: "Grok Build Stop blocking requires a non-empty continuation prompt." });
    return Object.freeze({ ok: true, response: Object.freeze({ decision: "block", reason: input.prompt }) });
  },
  probe(input) {
    const compatibility = probeContinuationSurface(grokBuildContinuationDeclaration, input);
    if (compatibility.status === "blocked" || !input.repoRoot) return compatibility;
    const hookPath = path.join(input.repoRoot, ...hookAsset.relativePath.split("/"));
    if (!existsSync(hookPath)) return compatibility;
    const trust = inspectGrokBuildFolderTrust(input.repoRoot);
    return trust.trusted
      ? Object.freeze({ status: "ready" as const, code: "grok-hook-trusted", reason: "Grok Build project Stop hook is present and the folder is trusted.", path: trust.trustFile, nextAction: "Continue using the trusted project hook." })
      : Object.freeze({ status: "blocked" as const, code: "grok-hook-untrusted", reason: "Grok Build project Stop hook is present but the folder is not trusted. Untrusted project hooks do not run.", path: trust.trustFile, nextAction: "Run /hooks-trust in Grok Build, or start with --trust, then rerun aiu doctor --json.", severity: "warning" as const });
  },
});

export interface GrokBuildFolderTrustInspection { readonly trustFile: string; readonly trusted: boolean }

export function inspectGrokBuildFolderTrust(repoRoot: string, env: NodeJS.ProcessEnv = process.env): GrokBuildFolderTrustInspection {
  const override = env.GROK_HOME?.trim();
  const trustFile = path.join(override && override.length > 0 ? override : path.join(os.homedir(), ".grok"), "trusted_folders.toml");
  if (!existsSync(trustFile)) return { trustFile, trusted: false };
  let text: string;
  try { text = readFileSync(trustFile, "utf8"); } catch { return { trustFile, trusted: false }; }
  const repo = normalizeFolderPath(repoRoot);
  const trusted = parseTrustedFolders(text).some((folder) => folder.trusted && isSameOrChildFolder(repo, normalizeFolderPath(folder.path)));
  return { trustFile, trusted };
}

function parseTrustedFolders(text: string): readonly { readonly path: string; readonly trusted: boolean }[] {
  const folders: Array<{ path: string; trusted: boolean }> = [];
  const section = /\[folders\.(?:'([^']+)'|"([^"]+)")\]/g;
  let match: RegExpExecArray | null;
  while ((match = section.exec(text)) !== null) {
    const folderPath = match[1] ?? match[2] ?? "";
    const rest = text.slice(match.index + match[0].length);
    const nextSection = rest.search(/\n\[/);
    const body = nextSection === -1 ? rest : rest.slice(0, nextSection);
    folders.push({ path: folderPath, trusted: /^\s*trusted\s*=\s*true\s*$/im.test(body) });
  }
  return folders;
}

function isSameOrChildFolder(repo: string, trustedFolder: string): boolean {
  if (repo === trustedFolder) return true;
  const prefix = trustedFolder.endsWith(path.sep) ? trustedFolder : `${trustedFolder}${path.sep}`;
  return repo.startsWith(prefix);
}

function normalizeFolderPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" && /^[A-Za-z]:/.test(resolved) ? resolved[0]!.toLowerCase() + resolved.slice(1) : resolved;
}

function validation(state: ContinuationAssetValidation["state"], reason: string): ContinuationAssetValidation { return Object.freeze({ state, reason }); }
function unknownAsset(assetId: string): ContinuationAssetValidation { return validation("malformed", `Unknown Grok Build continuation asset: ${assetId}.`); }
function failedUnknownAsset(assetId: string): ContinuationAssetMerge { const result = unknownAsset(assetId); return Object.freeze({ ok: false, reason: result.reason, validation: result }); }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
