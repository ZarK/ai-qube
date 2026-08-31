import type { Config } from './config/index.js';
import {
  evaluateGitHubReadiness,
  type EvaluateGitHubReadinessOptions,
  type GitHubReadiness,
} from './providers/github_adapter_exports.js';
import type { GitHubCapability, GitHubRole } from '@tjalve/qube-adapter-github';

export interface ConfiguredGitHubReadinessOptions extends Omit<EvaluateGitHubReadinessOptions, 'roles' | 'capabilities' | 'publisher'> {
  readonly additionalRoles?: readonly GitHubRole[];
  readonly additionalCapabilities?: readonly GitHubCapability[];
}

export function selectedGitHubRoles(config: Config, additionalRoles: readonly GitHubRole[] = []): readonly GitHubRole[] {
  const roles: GitHubRole[] = [...additionalRoles];
  if (config.providers.work.kind === 'github') roles.push('work');
  if (config.providers.ci.kind === 'github') roles.push('ci');
  if (config.providers.review.kind === 'github') roles.push('review');
  return Object.freeze([...new Set(roles)]);
}

export function hasUsableGitHubConnection(readiness: GitHubReadiness): boolean {
  return readiness.status === 'ready'
    || (readiness.status === 'unverified' && Boolean(readiness.cliVersion && readiness.host && readiness.repository));
}

export async function evaluateConfiguredGitHubReadiness(
  config: Config,
  options: ConfiguredGitHubReadinessOptions = {},
): Promise<GitHubReadiness> {
  const roles = selectedGitHubRoles(config, options.additionalRoles);
  return evaluateGitHubReadiness({
    ...options,
    roles,
    capabilities: options.additionalCapabilities,
    publisher: config.providers.review.kind === 'github' ? config.providers.review.publisher : null,
  });
}
