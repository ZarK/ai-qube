import type { LiveSuiteProvider } from "./provisioner.js";

export interface LiveCombinationArchetype {
  readonly id: "github-all-in-one" | "gitlab-all-in-one" | "enterprise-split" | "saas-split";
  readonly work: string;
  readonly review: string;
  readonly ci: string;
  readonly liveProviders: readonly LiveSuiteProvider[];
}

export const LIVE_COMBINATION_ARCHETYPES: readonly LiveCombinationArchetype[] = Object.freeze([
  Object.freeze({ id: "github-all-in-one", work: "github", review: "github", ci: "github", liveProviders: Object.freeze([]) }),
  Object.freeze({ id: "gitlab-all-in-one", work: "gitlab", review: "gitlab", ci: "gitlab", liveProviders: Object.freeze(["gitlab"] as const) }),
  Object.freeze({ id: "enterprise-split", work: "jira", review: "gitlab", ci: "jenkins", liveProviders: Object.freeze(["jira", "gitlab", "jenkins"] as const) }),
  Object.freeze({ id: "saas-split", work: "linear", review: "github", ci: "github", liveProviders: Object.freeze(["linear"] as const) }),
]);

export function liveProvidersForArchetype(id: LiveCombinationArchetype["id"]): readonly LiveSuiteProvider[] {
  const archetype = LIVE_COMBINATION_ARCHETYPES.find(entry => entry.id === id);
  if (!archetype) {
    throw new Error(`Unknown live combination archetype ${id}.`);
  }
  return archetype.liveProviders;
}
