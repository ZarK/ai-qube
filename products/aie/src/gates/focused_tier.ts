import type { FocusedGateSelector } from '../config/types.js';
import { matchRepoGlob, normalizeRepoRelativePath } from './path_glob.js';

export type GateRound = 'fix' | 'ship';
export type GateTier = 'focused' | 'full';
export type GateTierReason =
  | 'ship-round'
  | 'all-paths-matched'
  | 'unmapped-path'
  | 'changed-paths-missing'
  | 'selectors-unconfigured'
  | 'unsafe-path';

export interface FocusedTierSelection {
  tier: GateTier;
  tierReason: GateTierReason;
  selectedCommands: string[];
  unmatchedPaths: string[];
  changedPaths: string[];
  shipRequiresFullTier: true;
}

export function isGateRound(value: string | undefined): value is GateRound {
  return value === 'fix' || value === 'ship';
}

export function selectFocusedTier(input: {
  readonly round?: GateRound;
  readonly changedPaths?: readonly string[];
  readonly selectors: readonly FocusedGateSelector[];
  readonly fullCommands: readonly string[];
}): FocusedTierSelection {
  const fullCommands = unique(input.fullCommands);
  const ship = {
    tier: 'full' as const,
    selectedCommands: fullCommands,
    unmatchedPaths: [] as string[],
    changedPaths: [] as string[],
    shipRequiresFullTier: true as const,
  };

  if (input.round !== 'fix') {
    return { ...ship, tierReason: 'ship-round' };
  }
  if (input.selectors.length === 0) {
    return { ...ship, tierReason: 'selectors-unconfigured' };
  }
  const rawPaths = input.changedPaths ?? [];
  if (rawPaths.length === 0) {
    return { ...ship, tierReason: 'changed-paths-missing' };
  }

  const changedPaths: string[] = [];
  for (const raw of rawPaths) {
    const normalized = normalizeRepoRelativePath(raw);
    if (!normalized.ok) {
      return { ...ship, changedPaths: rawPaths.map(path => path.trim()), unmatchedPaths: [raw], tierReason: 'unsafe-path' };
    }
    changedPaths.push(normalized.path);
  }

  const unmatchedPaths = changedPaths.filter(path => !input.selectors.some(selector => matchRepoGlob(path, selector.glob)));
  if (unmatchedPaths.length > 0) {
    return { ...ship, changedPaths, unmatchedPaths, tierReason: 'unmapped-path' };
  }

  const selectedCommands = unique(input.selectors
    .filter(selector => changedPaths.some(path => matchRepoGlob(path, selector.glob)))
    .flatMap(selector => selector.commands));
  return {
    tier: 'focused',
    tierReason: 'all-paths-matched',
    selectedCommands,
    unmatchedPaths: [],
    changedPaths,
    shipRequiresFullTier: true,
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(value => value.trim() !== ''))];
}
