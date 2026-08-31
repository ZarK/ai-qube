import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config/index.js';
import {
  buildGateReadinessDiagnostics,
  buildInstructionPolicyDiagnostics,
  buildInstructionRecommendations,
} from '../doctor_diagnostics/index.js';
import { readManagedToolVersion } from '../managed_file.js';
import { getInstructionStatus } from '../repo/index.js';
import { readAiePackageVersion } from '../review_mode.js';
import { hasUsableGitHubConnection } from '../github_readiness.js';
import type { GitHubReadiness } from '../providers/github_adapter_exports.js';

export function collectSetupDoctorRecommendations(repoRoot: string, config: Config, githubReadiness?: GitHubReadiness): string[] {
  const instructions = getInstructionStatus(repoRoot);
  const instructionPolicy = buildInstructionPolicyDiagnostics(config, repoRoot);
  const recommendations = buildInstructionRecommendations({
    repoRoot,
    instructions,
    instructionPolicy,
    supplyChainSafetyConfigured: config.instructions.supplyChainSafety,
  });
  const running = readAiePackageVersion();
  const versions = [...new Set(instructions.harnesses
    .filter(harness => harness.installed)
    .flatMap(harness => harness.targets.filter(target => target.kind === 'instructions').map(target => target.path)))]
    .map(name => join(repoRoot, name))
    .filter(path => existsSync(path))
    .map(path => readManagedToolVersion(readFileSync(path, 'utf8')));
  if (versions.length === 0 || versions.some(version => version !== running)) {
    recommendations.push(`Managed instructions are older than the running tool (${versions.find(version => version !== null) ?? 'missing'} vs ${running}). Run \`aie init . --force\` to refresh them.`);
  }
  const gateReadiness = buildGateReadinessDiagnostics(config, {
    ghAuthenticated: githubReadiness ? hasUsableGitHubConnection(githubReadiness) : false,
    githubReadiness,
    evidenceRoot: repoRoot,
  });
  if (gateReadiness.gates.invalidCommands.length > 0) {
    recommendations.push(`Configured gates have invalid commands: ${gateReadiness.gates.invalidCommands.join(', ')}.`);
  }
  if (gateReadiness.audit.readiness === 'needs-action') {
    recommendations.push(
      gateReadiness.audit.agentBrowser.state === 'present-but-failing'
        ? 'Manual UI audit is enabled but agent-browser failed its capability probe.'
        : 'Manual UI audit is enabled but agent-browser was not found on PATH.',
    );
  }
  if (gateReadiness.aiq.enabled && gateReadiness.aiq.readiness === 'missing') {
    recommendations.push('Quality Control is enabled but aiq readiness is missing.');
  }
  if (gateReadiness.reviewAgent.localRunner.readiness === 'unavailable') {
    recommendations.push('Local review-agent adapter is configured without a local runner.');
  }
  if (gateReadiness.supplyChain.readiness === 'needs-action') {
    recommendations.push('Supply-chain policy is configured but not strict enough for normal readiness.');
  }
  return recommendations;
}
