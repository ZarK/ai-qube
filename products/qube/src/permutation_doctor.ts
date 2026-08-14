import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  composeProviderPermutation,
  validateConfig,
  type CapabilityObservation,
  type ProviderComposition,
} from "@tjalve/aie";

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
  const composition = await composeProviderPermutation(validated.config);
  return summarizeComposition(composition);
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
