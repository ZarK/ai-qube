import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { detectInstalledRoutingHosts, resolveModelRouting, validateConfig, type ModelRoutingResolution } from "@tjalve/aie";

interface CapabilityObservation {
  readonly role: "work" | "review" | "ci";
  readonly id: string;
  readonly support: "supported" | "unsupported" | "unknown";
  readonly reasonCode: string;
  readonly summary: string;
}

interface ProviderComposition {
  readonly work: { readonly id: string };
  readonly review: { readonly id: string };
  readonly ci: { readonly id: string };
  readonly observations: readonly CapabilityObservation[];
  readonly missing: readonly CapabilityObservation[];
}

export interface PermutationRoleSummary {
  readonly role: "work" | "review" | "ci";
  readonly kind: string;
  readonly capabilities: readonly CapabilityObservation[];
}

export interface PermutationDoctorResult {
  readonly status: "ok" | "missing" | "invalid";
  readonly summary: string;
  readonly work: PermutationRoleSummary | null;
  readonly review: PermutationRoleSummary | null;
  readonly ci: PermutationRoleSummary | null;
  readonly missing: readonly CapabilityObservation[];
}

export interface ModelRoutingDoctorResult {
  readonly status: "ok" | "missing" | "invalid";
  readonly summary: string;
  readonly resolution: ModelRoutingResolution | null;
}

export async function runModelRoutingDoctor(cwd: string): Promise<ModelRoutingDoctorResult> {
  const configPath = path.join(cwd, ".qube", "aie", "config.json");
  if (!existsSync(configPath)) {
    return { status: "missing", summary: "No Executor config was found; model routing cannot be resolved.", resolution: null };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return { status: "invalid", summary: "Executor config is malformed JSON; model routing cannot be resolved.", resolution: null };
  }
  const validated = validateConfig(raw);
  if (!validated.ok || !validated.config) {
    return { status: "invalid", summary: "Executor config is invalid; model routing cannot be resolved.", resolution: null };
  }
  const resolution = resolveModelRouting(validated.config.modelRouting, validated.config.reviewModels, detectInstalledRoutingHosts());
  const substitutions = resolution.substitutions.length;
  return {
    status: "ok",
    summary: substitutions === 0
      ? `Active modelRouting primary is ${resolution.primary.id}.`
      : `Active modelRouting primary is ${resolution.primary.id} with ${substitutions} substitution(s).`,
    resolution,
  };
}

export function formatModelRoutingDoctor(result: ModelRoutingDoctorResult): string {
  const lines = ["Model routing:", `- ${result.status}: ${result.summary}`];
  if (result.resolution) {
    for (const routeClass of ["mechanical-implementation", "exploration-investigation", "synthesis-judgment"] as const) {
      const route = result.resolution.routes[routeClass];
      lines.push(`- ${routeClass}: ${route.selected.id}${route.substitutions.length > 0 ? ` (substituted from ${route.preferred})` : ""}`);
    }
    const review = result.resolution.routes["independent-review"];
    lines.push(`- independent-review: reviewModels.${review.reviewTier}${review.model ? ` -> ${review.model}` : ""}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function runPermutationDoctor(cwd: string): Promise<PermutationDoctorResult> {
  const configPath = path.join(cwd, ".qube", "aie", "config.json");
  if (!existsSync(configPath)) {
    return Object.freeze({
      status: "missing",
      summary: "No Executor config was found; the active provider permutation cannot be summarized.",
      work: null,
      review: null,
      ci: null,
      missing: Object.freeze([]),
    });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return Object.freeze({
      status: "invalid",
      summary: "Executor config is malformed JSON; the active provider permutation cannot be summarized.",
      work: null,
      review: null,
      ci: null,
      missing: Object.freeze([]),
    });
  }
  const validated = validateConfig(raw);
  if (!validated.ok || !validated.config) {
    const firstError = validated.errors[0];
    return Object.freeze({
      status: "invalid",
      summary: `Executor config is invalid${firstError ? ` at ${firstError.path}: ${firstError.message}` : "."}`,
      work: null,
      review: null,
      ci: null,
      missing: Object.freeze([]),
    });
  }
  const compose = await loadComposeProviderPermutation();
  if (!compose) {
    return kindsOnlySummary(validated.config.providers);
  }
  const composition = await compose(validated.config);
  return summarizeComposition(composition);
}

async function loadComposeProviderPermutation(): Promise<((config: unknown) => Promise<ProviderComposition>) | undefined> {
  const imported = await import("@tjalve/aie") as { composeProviderPermutation?: (config: unknown) => Promise<ProviderComposition> };
  return typeof imported.composeProviderPermutation === "function" ? imported.composeProviderPermutation : undefined;
}

function kindsOnlySummary(providers: { readonly work: { readonly kind: string }; readonly review: { readonly kind: string }; readonly ci: { readonly kind: string } }): PermutationDoctorResult {
  const work = kindsOnlyRole("work", providers.work.kind);
  const review = kindsOnlyRole("review", providers.review.kind);
  const ci = kindsOnlyRole("ci", providers.ci.kind);
  return Object.freeze({
    status: "ok",
    summary: `Active permutation is work=${work.kind}, review=${review.kind}, ci=${ci.kind}.`,
    work,
    review,
    ci,
    missing: Object.freeze([]),
  });
}

function kindsOnlyRole(role: "work" | "review" | "ci", kind: string): PermutationRoleSummary {
  return Object.freeze({
    role,
    kind,
    capabilities: Object.freeze([]),
  });
}

export function summarizeComposition(composition: ProviderComposition): PermutationDoctorResult {
  const work = roleSummary("work", composition);
  const review = roleSummary("review", composition);
  const ci = roleSummary("ci", composition);
  const missing = Object.freeze(composition.missing.map(freezeObservation));
  return Object.freeze({
    status: "ok",
    summary: `Active permutation is work=${work.kind}, review=${review.kind}, ci=${ci.kind}.`,
    work,
    review,
    ci,
    missing,
  });
}

export function formatPermutationDoctor(result: PermutationDoctorResult): string {
  const lines = ["Provider permutation:", `- ${result.status}: ${result.summary}`];
  for (const role of [result.work, result.review, result.ci]) {
    if (!role) continue;
    lines.push(`- ${role.role}: ${role.kind}`);
    for (const capability of role.capabilities) {
      lines.push(`  - ${capability.id}: ${capability.support} — ${capability.summary}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function roleSummary(role: "work" | "review" | "ci", composition: ProviderComposition): PermutationRoleSummary {
  return Object.freeze({
    role,
    kind: composition[role].id,
    capabilities: Object.freeze(composition.observations.filter(item => item.role === role).map(freezeObservation)),
  });
}

function freezeObservation(item: CapabilityObservation): CapabilityObservation {
  return Object.freeze({
    role: item.role,
    id: item.id,
    support: item.support,
    reasonCode: item.reasonCode,
    summary: item.summary,
  });
}
