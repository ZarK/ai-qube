import type {
  ConnectionAuthMethod,
  ConnectionContract,
  ConnectionHttpRequest,
  ConnectionHttpResponse,
  ConnectionProbeOptions,
  ConnectionProbeResult,
  QubeAdapterContract,
  ReviewForgeProvider,
  ReviewItem,
  WorkItem,
  WorkProvider,
} from "@tjalve/qube-core";
import { readConnectionJsonResponse } from "@tjalve/qube-core";

import { RequestBudget } from "./request-budget.js";
import { SHARED_SEED_MANIFEST, type SeedManifest, type SeedWorkItem } from "./seed-manifest.js";

export const LIVE_SUITE_PROVIDERS = Object.freeze(["linear", "gitlab"] as const);
export type LiveSuiteProvider = (typeof LIVE_SUITE_PROVIDERS)[number];

export type LiveSuiteStatus = "passed" | "failed" | "skipped" | "error";
export type LiveSuiteReason =
  | "ok"
  | "no-live-flag"
  | "no-live-credentials"
  | "probe-failed"
  | "probe-unverified"
  | "unsupported-provider"
  | "unsupported-auth-mode"
  | "budget-exceeded"
  | "verify-failed"
  | "deconstruct-failed"
  | "residue-remaining"
  | "lifecycle-error";

export interface TaggedResource {
  readonly kind: string;
  readonly id: string;
  readonly tag: string;
}

export interface ProvisionerSandbox {
  readonly providerId: LiveSuiteProvider;
  readonly runId: string;
  readonly tag: string;
  readonly resources: readonly TaggedResource[];
  readonly workIds: Readonly<Record<string, string>>;
  readonly reviewId?: string;
  readonly projectId?: string;
  readonly teamId?: string;
}

export interface ProviderProvisioner {
  readonly providerId: LiveSuiteProvider;
  readonly mapsBlockedStatus: boolean;
  construct(): Promise<ProvisionerSandbox>;
  seed(sandbox: ProvisionerSandbox, manifest: SeedManifest): Promise<ProvisionerSandbox>;
  deconstruct(sandbox: ProvisionerSandbox): Promise<void>;
  sweep(tagPrefix?: string): Promise<readonly TaggedResource[]>;
}

export interface LiveSuiteContext {
  readonly adapter: QubeAdapterContract;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly config: Readonly<Record<string, unknown>>;
  readonly budget: RequestBudget;
  readonly fetchImpl: typeof fetch;
  readonly now?: () => number;
}

export interface LiveSuiteOptions {
  readonly adapter: QubeAdapterContract;
  readonly createProvisioner: (context: LiveSuiteContext) => ProviderProvisioner;
  readonly createWorkProvider: (sandbox: ProvisionerSandbox, context: LiveSuiteContext) => WorkProvider;
  readonly createReviewProvider?: (sandbox: ProvisionerSandbox, context: LiveSuiteContext) => ReviewForgeProvider;
  readonly probe: (options: ConnectionProbeOptions) => Promise<ConnectionProbeResult>;
  readonly manifest?: SeedManifest;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly liveEnvVar?: string;
  readonly fetchImpl?: typeof fetch;
  readonly budget?: RequestBudget;
  readonly probeOptions?: ConnectionProbeOptions;
}

export interface LiveSuiteResult {
  readonly status: LiveSuiteStatus;
  readonly reason: LiveSuiteReason;
  readonly summary: string;
  readonly providerId: string;
  readonly runId: string | null;
  readonly tag: string | null;
  readonly requestCount: number;
  readonly residue: readonly TaggedResource[];
  readonly verifiedWork: readonly string[];
}

const SKIPPED_NO_LIVE_CREDENTIALS = "skipped: no live credentials";

export function isLiveSuiteProvider(value: string): value is LiveSuiteProvider {
  return (LIVE_SUITE_PROVIDERS as readonly string[]).includes(value);
}

export function evaluateLiveGate(input: {
  readonly adapter: QubeAdapterContract;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly config: Readonly<Record<string, unknown>>;
  readonly liveEnvVar: string;
}): { readonly status: LiveSuiteStatus; readonly reason: LiveSuiteReason; readonly summary: string } {
  const providerId = input.adapter.id;
  if (!isLiveSuiteProvider(providerId)) {
    return {
      status: "error",
      reason: "unsupported-provider",
      summary: `Live provisioner suite does not support provider ${providerId}.`,
    };
  }
  const authMethod = input.adapter.connection?.authMethod as ConnectionAuthMethod | undefined;
  if (authMethod !== "token-env") {
    return {
      status: "error",
      reason: "unsupported-auth-mode",
      summary: `Live provisioner suite requires token-env authentication; ${providerId} uses ${authMethod ?? "unknown"}.`,
    };
  }
  if (input.env[input.liveEnvVar] !== "1") {
    return { status: "skipped", reason: "no-live-flag", summary: SKIPPED_NO_LIVE_CREDENTIALS };
  }
  if (!hasRequiredCredentials(input.adapter.connection, input.env, input.config)) {
    return { status: "skipped", reason: "no-live-credentials", summary: SKIPPED_NO_LIVE_CREDENTIALS };
  }
  return { status: "passed", reason: "ok", summary: "Live suite gate passed." };
}

export async function runProvisionerLifecycle(options: LiveSuiteOptions): Promise<LiveSuiteResult> {
  const env = options.env ?? process.env;
  const config = options.config ?? {};
  const liveEnvVar = options.liveEnvVar ?? "QUBE_TESTKIT_LIVE";
  const budget = options.budget ?? new RequestBudget();
  const fetchImpl = options.fetchImpl ?? fetch;
  const provisionerFetch = budget.wrapFetch(fetchImpl);
  const gate = evaluateLiveGate({
    adapter: options.adapter,
    env,
    config,
    liveEnvVar,
  });
  if (gate.status !== "passed") {
    return emptyResult(options.adapter.id, gate.status, gate.reason, gate.summary, budget.requestCount);
  }

  let probe;
  try {
    budget.consume("probe");
    const innerProbeFetch = options.probeOptions?.fetch;
    probe = await options.probe({
      mode: options.probeOptions?.mode ?? "live",
      env,
      config,
      ...options.probeOptions,
      timeoutMs: options.probeOptions?.timeoutMs ?? budget.timeoutMs,
      fetch: async (request: ConnectionHttpRequest) => {
        budget.consume("probe-http");
        if (innerProbeFetch) return innerProbeFetch(request);
        return fetchConnectionThroughBudget(request, provisionerFetch);
      },
    });
  } catch (error) {
    const reason = classifyLifecycleError(error);
    const summary = error instanceof Error ? error.message : String(error);
    return emptyResult(options.adapter.id, "failed", reason, summary, budget.requestCount);
  }
  if (probe.status === "fail") {
    return emptyResult(options.adapter.id, "failed", "probe-failed", probe.summary, budget.requestCount);
  }
  if (probe.status !== "pass") {
    return emptyResult(options.adapter.id, "failed", "probe-unverified", probe.summary, budget.requestCount);
  }

  const context: LiveSuiteContext = {
    adapter: options.adapter,
    env,
    config,
    budget,
    fetchImpl: provisionerFetch,
  };
  const provisioner = options.createProvisioner(context);
  if (provisioner.providerId !== options.adapter.id) {
    return emptyResult(
      options.adapter.id,
      "error",
      "unsupported-provider",
      `Provisioner ${provisioner.providerId} does not match adapter ${options.adapter.id}.`,
      budget.requestCount,
    );
  }

  let sandbox: ProvisionerSandbox | undefined;
  try {
    sandbox = await provisioner.construct();
    sandbox = await provisioner.seed(sandbox, options.manifest ?? SHARED_SEED_MANIFEST);
    const verifiedWork = await verifySeededWork(sandbox, options, context, provisioner.mapsBlockedStatus);
    if (options.createReviewProvider && sandbox.reviewId) {
      await verifySeededReview(sandbox, options, context);
    }
    await provisioner.deconstruct(sandbox);
    const residue = await provisioner.sweep(sandbox.tag);
    if (residue.length > 0) {
      return resultFrom(sandbox, "failed", "residue-remaining", `Sweep found ${residue.length} tagged leftover resource(s).`, budget.requestCount, residue, verifiedWork);
    }
    return resultFrom(sandbox, "passed", "ok", "Live run constructed, verified, and deconstructed with zero residue.", budget.requestCount, [], verifiedWork);
  } catch (error) {
    const reason = classifyLifecycleError(error);
    const summary = error instanceof Error ? error.message : String(error);
    if (sandbox) {
      try {
        await provisioner.deconstruct(sandbox);
        const residue = await provisioner.sweep(sandbox.tag);
        return resultFrom(sandbox, "failed", reason, summary, budget.requestCount, residue, []);
      } catch (cleanupError) {
        const cleanup = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        return resultFrom(sandbox, "failed", "deconstruct-failed", `${summary}; cleanup failed: ${cleanup}`, budget.requestCount, sandbox.resources, []);
      }
    }
    return emptyResult(options.adapter.id, "failed", reason, summary, budget.requestCount);
  }
}

export async function verifySeededWork(
  sandbox: ProvisionerSandbox,
  options: LiveSuiteOptions,
  context: LiveSuiteContext,
  mapsBlockedStatus: boolean,
): Promise<readonly string[]> {
  const manifest = options.manifest ?? SHARED_SEED_MANIFEST;
  const provider = options.createWorkProvider(sandbox, context);
  const items = await provider.listOpenWorkItems();
  const verified: string[] = [];
  for (const seed of manifest.workItems) {
    const title = `[${sandbox.tag}] ${seed.title}`;
    const item = items.find(candidate => candidate.title === title)
      ?? await loadSeededItem(provider, sandbox.workIds[seed.id]);
    if (!item) {
      throw new Error(`Live verify did not observe seeded work item ${seed.id} (${title}).`);
    }
    assertSeededWorkItem(item, seed, mapsBlockedStatus);
    const loaded = await provider.getWorkItem(item.key);
    if (loaded.title !== item.title) {
      throw new Error(`Live verify getWorkItem title mismatch for ${seed.id}.`);
    }
    verified.push(seed.id);
  }
  return verified;
}

function assertSeededWorkItem(item: WorkItem, seed: SeedWorkItem, mapsBlockedStatus: boolean): void {
  if (item.priority !== seed.priority) {
    throw new Error(`Live verify priority mismatch for ${seed.id}: observed ${item.priority}, expected ${seed.priority}.`);
  }
  if (seed.status === "ready" || seed.status === "in-progress") {
    if (item.status !== seed.status) {
      throw new Error(`Live verify status mismatch for ${seed.id}: observed ${item.status}, expected ${seed.status}.`);
    }
  }
  if (mapsBlockedStatus && seed.status === "blocked" && item.status !== "blocked") {
    throw new Error(`Live verify blocked status missing for ${seed.id}.`);
  }
  if (seed.blockedBy.length > 0 && item.blockers.length === 0 && item.blockedBy.length === 0) {
    throw new Error(`Live verify blocker edge missing for ${seed.id}.`);
  }
  if (seed.checklist.length > 0 && item.checklist.total < seed.checklist.length) {
    throw new Error(`Live verify checklist missing for ${seed.id}.`);
  }
}

async function loadSeededItem(provider: WorkProvider, id: string | undefined): Promise<WorkItem | undefined> {
  if (!id) return undefined;
  try {
    return await provider.getWorkItem({ providerId: provider.id, id });
  } catch {
    return undefined;
  }
}

async function verifySeededReview(
  sandbox: ProvisionerSandbox,
  options: LiveSuiteOptions,
  context: LiveSuiteContext,
): Promise<void> {
  if (!options.createReviewProvider || !sandbox.reviewId) return;
  const reviewProvider = options.createReviewProvider(sandbox, context);
  const item = await reviewProvider.getReviewItem({ providerId: reviewProvider.id, id: sandbox.reviewId }) as ReviewItem;
  const expected = `[${sandbox.tag}] ${(options.manifest ?? SHARED_SEED_MANIFEST).reviewItem.title}`;
  if (item.title !== expected) {
    throw new Error(`Live verify review title mismatch: observed ${item.title}, expected ${expected}.`);
  }
}

function hasRequiredCredentials(
  contract: ConnectionContract | undefined,
  env: Readonly<Record<string, string | undefined>>,
  config: Readonly<Record<string, unknown>>,
): boolean {
  if (!contract) return false;
  for (const variable of contract.envVars) {
    if (!present(env[variable.name])) return false;
  }
  for (const field of contract.configFields) {
    if (!field.required) continue;
    const configured = config[field.name];
    if (typeof configured === "string" && configured.trim() !== "") continue;
    if (typeof configured === "number" && Number.isFinite(configured)) continue;
    if (field.envFallback && present(env[field.envFallback])) continue;
    if (field.defaultValue && field.defaultValue.trim() !== "") continue;
    return false;
  }
  return true;
}

async function fetchConnectionThroughBudget(
  request: ConnectionHttpRequest,
  fetchImpl: typeof fetch,
): Promise<ConnectionHttpResponse> {
  const headers: Record<string, string> = { ...request.headers };
  if (request.basicAuth) {
    headers.Authorization = `Basic ${Buffer.from(`${request.basicAuth.username}:${request.basicAuth.password}`, "utf8").toString("base64")}`;
  }
  const response = await fetchImpl(request.url, {
    method: request.method,
    headers,
    ...(request.body === undefined ? {} : { body: request.body }),
    signal: AbortSignal.timeout(request.timeoutMs),
  });
  return { status: response.status, body: await readConnectionJsonResponse(response) };
}

function present(value: string | undefined): boolean {
  return typeof value === "string" && value.trim() !== "";
}

function classifyLifecycleError(error: unknown): LiveSuiteReason {
  if (error instanceof Error && error.name === "RequestBudgetExceededError") return "budget-exceeded";
  if (error instanceof Error && /Live verify/.test(error.message)) return "verify-failed";
  return "lifecycle-error";
}

function emptyResult(
  providerId: string,
  status: LiveSuiteStatus,
  reason: LiveSuiteReason,
  summary: string,
  requestCount: number,
): LiveSuiteResult {
  return Object.freeze({
    status,
    reason,
    summary,
    providerId,
    runId: null,
    tag: null,
    requestCount,
    residue: Object.freeze([]),
    verifiedWork: Object.freeze([]),
  });
}

function resultFrom(
  sandbox: ProvisionerSandbox,
  status: LiveSuiteStatus,
  reason: LiveSuiteReason,
  summary: string,
  requestCount: number,
  residue: readonly TaggedResource[],
  verifiedWork: readonly string[],
): LiveSuiteResult {
  if (status === "passed" && (reason !== "ok" || residue.length > 0)) {
    throw new Error("Live suite refused to report passed with leftover residue or a non-ok reason.");
  }
  return Object.freeze({
    status,
    reason,
    summary,
    providerId: sandbox.providerId,
    runId: sandbox.runId,
    tag: sandbox.tag,
    requestCount,
    residue: Object.freeze([...residue]),
    verifiedWork: Object.freeze([...verifiedWork]),
  });
}
