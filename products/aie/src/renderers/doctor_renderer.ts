import type { DoctorDiagnostics } from '../doctor_diagnostics/index.js';

function pushConfigAndQueue(lines: string[], diagnostics: DoctorDiagnostics): void {
  if (diagnostics.configErrors && diagnostics.configErrors.length > 0) lines.push(`Config errors: ${diagnostics.configErrors.length} (see recommendations)`);
  lines.push(`Labels: ${diagnostics.labelsOk ? 'ok' : 'issues'}${diagnostics.labelsError ? ' — ' + diagnostics.labelsError : ''}`);
  if (!diagnostics.labelsOk && !diagnostics.labelsError && (diagnostics.labelsMissing.length > 0 || diagnostics.labelsDrifted.length > 0 || diagnostics.labelsDuplicates.length > 0)) lines.push(`Labels details: missing=${diagnostics.labelsMissing.length}, drifted=${diagnostics.labelsDrifted.length}, duplicates=${diagnostics.labelsDuplicates.length} (see recommendations)`);
  const hasQueueIssue = diagnostics.queueDriftCount > 0 || diagnostics.queueMultipleInProgress || !!diagnostics.queueError;
  lines.push(`Queue: ${hasQueueIssue ? (diagnostics.queueMultipleInProgress ? 'multiple in progress' : 'issues') : 'ok'} (drift: ${diagnostics.queueDriftCount})${diagnostics.queueError ? ' — ' + diagnostics.queueError : ''}`);
  if (hasQueueIssue) lines.push(`Queue details: drift=${diagnostics.queueDriftCount}, multipleInProgress=${diagnostics.queueMultipleInProgress} (see recommendations)`);
}

function pushInstructionAndGateState(lines: string[], diagnostics: DoctorDiagnostics): void {
  const targetSummary = diagnostics.instructions.targets.map(target => `${target.path}=${target.present ? (target.healthy ? 'managed' : target.managed ? 'managed-needs-refresh' : 'unmanaged') : 'missing'}`).join(', ');
  const readiness = diagnostics.gateReadiness;
  lines.push(`Instructions: ${targetSummary}`);
  lines.push(`Instruction policy: naming=${diagnostics.instructionPolicy.namingRules.installed ? 'installed' : diagnostics.instructionPolicy.namingRules.configured ? 'missing' : 'disabled'}, guardrails=${diagnostics.instructionPolicy.implementationGuardrails.installed ? 'installed' : diagnostics.instructionPolicy.implementationGuardrails.configured ? 'missing' : 'disabled'}, supply-chain=${diagnostics.instructionPolicy.supplyChainSafety.installed ? 'installed' : diagnostics.instructionPolicy.supplyChainSafety.configured ? 'missing' : 'disabled'}, canonical-guard=${diagnostics.instructionPolicy.canonicalSupplyChainGuard.installed ? 'installed' : diagnostics.instructionPolicy.canonicalSupplyChainGuard.configured ? 'missing' : 'disabled'}`);
  lines.push(`Gate readiness: configured=${readiness.gates.configured}, required=${readiness.gates.required}, supply-chain-sensitive=${readiness.gates.supplyChainSensitive}, external-service=${readiness.gates.externalServiceGates.length}`);
  lines.push(`Migration readiness: state=${diagnostics.migrationReadiness.legacyState}, detected=${diagnostics.migrationReadiness.detectedPaths}, categories=${diagnostics.migrationReadiness.detectedCategories.join(', ') || 'none'}, cleanup=${diagnostics.migrationReadiness.cleanupStatus}, conflicts=${diagnostics.migrationReadiness.conflicts}`);
  lines.push(`Compatibility wrappers: installed=${diagnostics.migrationReadiness.wrapperState.installed}, stale=${diagnostics.migrationReadiness.wrapperState.stale}`);
  lines.push(`Remaining legacy references: ${diagnostics.migrationReadiness.remainingLegacyReferences.count}`);
  lines.push(`Manual UI audit: ${readiness.audit.manualUiAudit ? readiness.audit.readiness : 'disabled'}; agent-browser=${readiness.audit.agentBrowser.available ? 'available' : 'missing'}; screenshot upload=${readiness.audit.screenshotUpload}`);
  lines.push(`Review-agent gate: reviewers=${readiness.reviewAgent.reviewers.join(', ')}, fallback=${readiness.reviewAgent.fallbackPromptAvailable ? 'available' : 'missing'}, external-services=${readiness.reviewAgent.externalServices.length}`);
  lines.push(`PR review gate: ${readiness.prReview.readiness}; reviewers=${readiness.prReview.reviewers.length}; wait=${readiness.prReview.reviewWaitMinutes} minutes; gh=${readiness.prReview.ghAuthenticated ? 'authenticated' : 'not authenticated'}`);
  lines.push(`Review preflight: ${readiness.reviewPreflight.readiness}; disk=${readiness.reviewPreflight.checks.disk.readiness}; dist=${readiness.reviewPreflight.checks.dist.readiness}; loose-objects=${readiness.reviewPreflight.checks.gitObjects.readiness}`);
  lines.push(`Quality Control gate: ${readiness.aiq.enabled ? readiness.aiq.readiness : 'disabled'}; aiq=${readiness.aiq.tool.available ? 'available' : 'missing'}`);
  lines.push(`Supply-chain gates: policy=${readiness.supplyChain.readiness}, sensitive=${readiness.supplyChain.supplyChainSensitiveGates.length}, lifecycle-scripts=${readiness.supplyChain.disableLifecycleScripts ? 'disabled' : 'not disabled'}`);
  lines.push(`External services: ${readiness.externalServices.length > 0 ? readiness.externalServices.join(', ') : 'none configured'}`);
}

export function formatDoctorHuman(diagnostics: DoctorDiagnostics): string {
  const lines: string[] = [];
  lines.push('AI Executor doctor');
  lines.push(`Node: ${diagnostics.nodeVersion} (satisfies Node.js 24 LTS or newer: ${diagnostics.nodeSatisfies ? 'yes' : 'no'})`);
  lines.push(`CWD: ${diagnostics.cwd}`);
  lines.push(`Branch: ${diagnostics.currentBranch}`);
  lines.push(`git: ${diagnostics.git ? 'available' : 'missing'}`);
  lines.push(`gh: ${diagnostics.gh ? (diagnostics.ghAuthenticated ? 'authenticated' : 'not authenticated') : 'missing'}`);
  lines.push(`Worktree: ${diagnostics.isWorktree ? (diagnostics.repositoryPolicy.noWorktree ? 'yes (policy violation — switch to primary checkout)' : 'yes (allowed by policy)') : 'no'}`);
  lines.push(`Config: ${diagnostics.configPresent ? (diagnostics.configValid ? 'valid' : 'invalid') : 'not found (using defaults)'}`);
  if (diagnostics.baseBranch) lines.push(`Base: ${diagnostics.baseRemote || 'origin'}/${diagnostics.baseBranch}`);
  lines.push(`Base ref: ${diagnostics.baseRef.remote}/${diagnostics.baseRef.branch} ${diagnostics.baseRef.resolved ? (diagnostics.baseRef.upToDate ? 'current' : 'stale') : 'unresolved'}`);
  lines.push(`Repository policy: no-worktree=${diagnostics.repositoryPolicy.noWorktree ? 'enabled' : 'disabled'}, open-PR blocking=${diagnostics.repositoryPolicy.blockOnOpenPRs ? 'enabled' : 'disabled'}, base=${diagnostics.repositoryPolicy.baseRemote}/${diagnostics.repositoryPolicy.baseBranch}, milestone ordering=${diagnostics.repositoryPolicy.milestoneOrdering ? diagnostics.repositoryPolicy.missingMilestonePolicy : 'disabled'}`);
  lines.push(`Providers: work=${diagnostics.providerHealth.providers.work.kind}, review=${diagnostics.providerHealth.providers.review.kind}, repository=${diagnostics.providerHealth.providers.repository.kind}, ci=${diagnostics.providerHealth.providers.ci.kind}, layout=${diagnostics.providerHealth.providers.layout.kind}`);
  lines.push(`Open PRs: ${diagnostics.openPullRequests.length} (${diagnostics.blockingPullRequests.length} blocking)`);
  if (diagnostics.pullRequestError) lines.push(`Open PR details: ${diagnostics.pullRequestError}`);
  pushConfigAndQueue(lines, diagnostics);
  pushInstructionAndGateState(lines, diagnostics);
  lines.push(`Legacy state: ${diagnostics.legacy.length > 0 ? diagnostics.legacy.map(item => `${item.category}=${item.paths.join(',')}`).join('; ') : 'none detected'}`);
  lines.push(`Planning artifacts: spec=${diagnostics.planning.spec ? 'yes' : 'no'}, milestones=${diagnostics.planning.milestones.length}`);
  lines.push(`Lifecycle readiness: ${diagnostics.lifecycle.lifecycleCommandsReady ? 'ready' : 'blocked'}; active issues=${diagnostics.lifecycle.inProgressIssueCount}; branch policy=${diagnostics.lifecycle.branchNamingValid ? 'valid' : 'invalid'}`);
  if (diagnostics.lifecycle.activeIssueNumber !== null) lines.push(`Active branch check: #${diagnostics.lifecycle.activeIssueNumber} expects ${diagnostics.lifecycle.activeIssueBranch ?? 'unknown'}; current match=${diagnostics.lifecycle.currentBranchMatchesActiveIssue === true ? 'yes' : 'no'}`);
  lines.push(`Milestones: ${diagnostics.milestones.length}; preservation warnings: ${diagnostics.milestoneWarnings.length}${diagnostics.milestoneError ? ' — ' + diagnostics.milestoneError : ''}`);
  if (diagnostics.milestoneWarnings.length > 0) lines.push(`Milestone warning details: ${diagnostics.milestoneWarnings.slice(0, 3).map(warning => warning.message).join(' ')}`);
  if (diagnostics.recommendations.length > 0) {
    lines.push('');
    lines.push('Recommendations:');
    diagnostics.recommendations.forEach(recommendation => lines.push(`- ${recommendation}`));
  }
  lines.push(`Next safe command: ${diagnostics.nextCommand}`);
  lines.push('');
  lines.push('Doctor complete. Address any issues above before starting new work.');
  return lines.join('\n');
}
