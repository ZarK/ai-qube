import { posix as pathPosix } from "node:path";

import type { AgentHostId } from "./agent_host.js";

export const CONTINUATION_ADAPTER_VERSION = 1 as const;
export const CONTINUATION_DECLARATION_VERSION = 1 as const;

export type ContinuationMode = "continue" | "repair" | "wait" | "stop";
export type ContinuationDeliveryMethod = "host-command" | "stdout-json";
export type ContinuationSessionScope = "selected-session" | "current-session";
export type ContinuationManagedAssetState = "current" | "missing" | "duplicate" | "malformed" | "conflicting";

export interface ContinuationNativeSurface {
  readonly id: string;
  readonly minimumVersion: string | null;
  readonly maximumVersionExclusive: string | null;
}

export interface ContinuationManagedAssetDeclaration {
  readonly id: string;
  readonly relativePath: string;
  readonly description: string;
  readonly ownership: "dedicated" | "shared";
  readonly role: "entrypoint" | "configuration";
}

export interface ContinuationDeclaration {
  readonly version: typeof CONTINUATION_DECLARATION_VERSION;
  readonly hostId: AgentHostId;
  readonly nativeSurfaces: readonly ContinuationNativeSurface[];
  readonly triggerEvents: readonly string[];
  readonly delivery: {
    readonly method: ContinuationDeliveryMethod;
    readonly sessionScope: ContinuationSessionScope;
  };
  readonly umpireModes: readonly ContinuationMode[];
  readonly trust: {
    readonly repositoryRequired: boolean;
    readonly description: string;
  };
  readonly managedAssets: readonly ContinuationManagedAssetDeclaration[];
  readonly activationEvidence: {
    readonly event: "plugin-event" | "stop-hook";
    readonly delivery: "host" | "stdout";
    readonly requiresSessionId: boolean;
  };
  readonly currentIssueRecovery: boolean;
}

export interface ContinuationRenderedAsset extends ContinuationManagedAssetDeclaration {
  readonly content: string;
}

export interface ContinuationRenderContext {
  readonly packageVersions: Readonly<Record<string, string>>;
}

export interface ContinuationAssetValidation {
  readonly state: ContinuationManagedAssetState;
  readonly reason: string;
}

export type ContinuationAssetMerge =
  | {
      readonly ok: true;
      readonly content: string;
      readonly changed: boolean;
      readonly validation: ContinuationAssetValidation;
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly validation: ContinuationAssetValidation;
    };

export interface ContinuationDecodedEvent {
  readonly event: string;
  readonly sessionId?: string;
  readonly selectedSessionId?: string;
  readonly cwd?: string;
  readonly stopHookActive?: boolean;
  readonly sessionEnd?: boolean;
  readonly suppressions?: readonly string[];
}

export type ContinuationDecodeResult =
  | { readonly ok: true; readonly event: ContinuationDecodedEvent }
  | { readonly ok: false; readonly code: "unsupported-event" | "malformed-event"; readonly error: string };

export interface ContinuationResponseInput {
  readonly decision: "allow" | "block" | "deliver";
  readonly prompt?: string;
  readonly sessionId?: string;
  readonly cwd?: string;
}

export type ContinuationEncodeResult =
  | { readonly ok: true; readonly response: unknown }
  | { readonly ok: false; readonly error: string };

export interface ContinuationProbeInput {
  readonly surface: string;
  readonly version: string | null;
  readonly repoRoot?: string;
  readonly packageVersions?: Readonly<Record<string, string>>;
}

export interface ContinuationProbeResult {
  readonly status: "ready" | "blocked";
  readonly reason: string;
  readonly code?: string;
  readonly path?: string;
  readonly nextAction?: string;
  readonly severity?: "warning" | "error";
}

export interface ContinuationAdapter {
  readonly version: typeof CONTINUATION_ADAPTER_VERSION;
  readonly declaration: ContinuationDeclaration;
  renderManagedAssets(context: ContinuationRenderContext): readonly ContinuationRenderedAsset[];
  validateManagedAsset(assetId: string, existing: string | undefined, desired: ContinuationRenderedAsset): ContinuationAssetValidation;
  mergeManagedAsset(assetId: string, existing: string, desired: ContinuationRenderedAsset): ContinuationAssetMerge;
  decodeEvent(input: unknown): ContinuationDecodeResult;
  encodeResponse(input: ContinuationResponseInput): ContinuationEncodeResult;
  probe(input: ContinuationProbeInput): ContinuationProbeResult;
}

export function defineContinuationDeclaration<T extends ContinuationDeclaration>(declaration: T): Readonly<T> {
  if (declaration.version !== CONTINUATION_DECLARATION_VERSION) {
    throw new TypeError(`Unsupported continuation declaration version: ${String(declaration.version)}.`);
  }
  if (declaration.nativeSurfaces.length === 0) throw new TypeError("Continuation declarations require at least one native surface.");
  if (declaration.triggerEvents.length === 0) throw new TypeError("Continuation declarations require at least one trigger event.");
  if (declaration.umpireModes.length === 0) throw new TypeError("Continuation declarations require at least one Umpire mode.");
  for (const asset of declaration.managedAssets) validateManagedAssetPath(asset.relativePath);
  return freezeSerializable(declaration, `continuation declaration ${declaration.hostId}`);
}

export function defineContinuationAdapter<T extends ContinuationAdapter>(adapter: T): Readonly<T> {
  if (adapter.version !== CONTINUATION_ADAPTER_VERSION) {
    throw new TypeError(`Unsupported continuation adapter version: ${String(adapter.version)}.`);
  }
  defineContinuationDeclaration(adapter.declaration);
  const executableFields = ["renderManagedAssets", "validateManagedAsset", "mergeManagedAsset", "decodeEvent", "encodeResponse", "probe"] as const;
  for (const field of executableFields) {
    if (typeof adapter[field] !== "function") {
      throw new TypeError(`Continuation adapter ${adapter.declaration.hostId} is missing executable function ${field}.`);
    }
  }
  return Object.freeze(adapter);
}

export function createContinuationAdapterRegistry(
  adapters: readonly ContinuationAdapter[],
): ReadonlyMap<AgentHostId, ContinuationAdapter> {
  const registry = new Map<AgentHostId, ContinuationAdapter>();
  for (const candidate of adapters) {
    const adapter = defineContinuationAdapter(candidate);
    const hostId = adapter.declaration.hostId;
    if (registry.has(hostId)) throw new TypeError(`Duplicate continuation adapter registration: ${hostId}.`);
    registry.set(hostId, adapter);
  }
  return registry;
}

export function validateManagedAssetPath(relativePath: string): void {
  const portable = relativePath.replaceAll("\\", "/");
  const normalized = pathPosix.normalize(portable);
  if (portable.length === 0 || pathPosix.isAbsolute(portable) || portable.startsWith("//") || /^[A-Za-z]:\//u.test(portable) || normalized === ".." || normalized.startsWith("../")) {
    throw new TypeError(`Managed continuation asset must stay inside the repository: ${relativePath}.`);
  }
}

export function validateDedicatedContinuationAsset(
  existing: string | undefined,
  desired: ContinuationRenderedAsset,
): ContinuationAssetValidation {
  if (existing === undefined) return Object.freeze({ state: "missing", reason: "Managed host file is missing." });
  return normalizeText(existing) === normalizeText(desired.content)
    ? Object.freeze({ state: "current", reason: "Dedicated managed file matches package content." })
    : Object.freeze({ state: "conflicting", reason: "Dedicated managed file differs from package content." });
}

export function mergeDedicatedContinuationAsset(
  existing: string,
  desired: ContinuationRenderedAsset,
): ContinuationAssetMerge {
  const validation = validateDedicatedContinuationAsset(existing, desired);
  return Object.freeze({
    ok: true as const,
    content: desired.content,
    changed: normalizeText(existing) !== normalizeText(desired.content),
    validation,
  });
}

export function probeContinuationSurface(
  declaration: ContinuationDeclaration,
  input: ContinuationProbeInput,
): ContinuationProbeResult {
  const surface = declaration.nativeSurfaces.find((candidate) => candidate.id === input.surface);
  if (!surface) return Object.freeze({ status: "blocked", reason: `Unsupported continuation surface: ${input.surface}.` });
  if (input.version !== null && surface.minimumVersion !== null && compareVersions(input.version, surface.minimumVersion) < 0) {
    return Object.freeze({ status: "blocked", reason: `Continuation surface ${input.surface} requires version ${surface.minimumVersion} or newer.` });
  }
  if (input.version !== null && surface.maximumVersionExclusive !== null && compareVersions(input.version, surface.maximumVersionExclusive) >= 0) {
    return Object.freeze({ status: "blocked", reason: `Continuation surface ${input.surface} requires a version older than ${surface.maximumVersionExclusive}.` });
  }
  return Object.freeze({ status: "ready", reason: `Continuation surface ${input.surface} is compatible.` });
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = right.split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function freezeSerializable<T>(value: T, path: string, ancestors = new WeakSet<object>()): Readonly<T> {
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint" || value === undefined) {
    throw new TypeError(`Serializable ${path} cannot contain executable or non-JSON values.`);
  }
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value)) throw new TypeError(`Serializable ${path} cannot contain cycles.`);
  ancestors.add(value);
  for (const [key, child] of Object.entries(value)) freezeSerializable(child, `${path}.${key}`, ancestors);
  ancestors.delete(value);
  return Object.freeze(value);
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").trimEnd();
}
