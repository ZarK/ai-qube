import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { getAgentHostProfileSync } from '../agent_host_adapters.js';
import { listHostModels, type HostModelListing } from '../app/model_catalog.js';
import { isRegisteredReviewHost } from '../app/review_host_adapters.js';
import { commandExistsOnPath, detectInstalledReviewHostsOnPath } from '../app/model_routing_hosts.js';
import { REVIEW_MODEL_HOST_IDS, type ReviewMode, type ReviewModelHostId } from '../core/policy.js';
import { isReviewMode, REVIEW_MODES } from '../review_mode.js';
import type { InitPolicyOptions, InitQuestion, InitQuestionId, InitQuestionOption, InitSetupSummary } from './types.js';
import type { InitTool } from '../init_content.js';
import { DEFAULT_UI_AUDIT_EVIDENCE_ROOT } from '../audit.js';
import type { InitExternalReviewer } from './review_selections.js';
import type { ReviewProviderKind } from '../config/index.js';

export interface GuideMachine {
  installedHosts: readonly ReviewModelHostId[];
  agentBrowserAvailable: boolean;
  aiqAvailable: boolean;
  hasUserFacingUi: boolean;
  liveModels?: Readonly<Partial<Record<ReviewModelHostId, readonly string[]>>>;
  modelCatalogs?: Readonly<Partial<Record<ReviewModelHostId, HostModelListing>>>;
  externalReviewers?: readonly InitExternalReviewer[];
}

export interface InvocationAnswers {
  reviewMode?: ReviewMode;
  reviewers?: string[];
  reviewModels?: string[];
  publisher?: 'user' | 'github-app' | 'token';
  qualityControl?: boolean;
  manualUiAudit?: boolean;
  uiAuditEvidenceRoot?: string;
  noCreditWarning?: boolean;
}

const UI_PACKAGE_HINTS = ['react', 'vue', 'svelte', 'next', 'nuxt', 'preact', 'solid-js', '@angular/core'];
const UI_FILE_HINTS = ['index.html', 'src/App.tsx', 'src/App.jsx', 'src/main.tsx', 'app/page.tsx', 'src/App.vue'];

export function detectGuideMachine(input: {
  repoRoot: string | null;
  installedHosts?: readonly string[];
  agentBrowserAvailable?: boolean;
  aiqAvailable?: boolean;
}): GuideMachine {
  const installedHosts = input.installedHosts
    ? REVIEW_MODEL_HOST_IDS.filter(host => input.installedHosts?.includes(host))
    : detectInstalledReviewHostsOnPath();
  const liveModels: Partial<Record<ReviewModelHostId, readonly string[]>> = {};
  const modelCatalogs: Partial<Record<ReviewModelHostId, HostModelListing>> = {};
  for (const host of installedHosts) {
    const listing = listHostModels(host);
    modelCatalogs[host] = listing;
    if (listing.status === 'ready') liveModels[host] = listing.models;
  }
  return {
    installedHosts,
    agentBrowserAvailable: input.agentBrowserAvailable ?? commandExistsOnPath('agent-browser'),
    aiqAvailable: input.aiqAvailable ?? commandExistsOnPath('aiq'),
    hasUserFacingUi: detectUserFacingUi(input.repoRoot),
    liveModels,
    modelCatalogs,
  };
}

export function detectUserFacingUi(repoRoot: string | null): boolean {
  if (!repoRoot) return false;
  if (UI_FILE_HINTS.some(relativePath => existsSync(join(repoRoot, relativePath)))) return true;
  const packagePath = join(repoRoot, 'package.json');
  if (!existsSync(packagePath)) return false;
  try {
    const raw = JSON.parse(readFileSync(packagePath, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const names = [...Object.keys(raw.dependencies ?? {}), ...Object.keys(raw.devDependencies ?? {})];
    return names.some(name => UI_PACKAGE_HINTS.includes(name));
  } catch {
    return false;
  }
}

export function isolatedReviewHostsOnMachine(machine: Pick<GuideMachine, 'installedHosts'>): readonly ReviewModelHostId[] {
  return machine.installedHosts.filter(host => isRegisteredReviewHost(host));
}

export function recommendedReviewMode(machine: GuideMachine): ReviewMode {
  if (isolatedReviewHostsOnMachine(machine).length > 0) return 'isolated';
  return 'external';
}

export function recommendedManualUiAudit(machine: GuideMachine): boolean {
  return machine.hasUserFacingUi && machine.agentBrowserAvailable;
}

export function recommendedQualityControl(machine: GuideMachine): boolean {
  return machine.aiqAvailable;
}

export function answersFromPolicy(policy: InitPolicyOptions | undefined): InvocationAnswers {
  const answers: InvocationAnswers = {};
  if (policy?.reviewMode !== undefined) answers.reviewMode = policy.reviewMode;
  if (policy?.reviewMode === 'host' && (policy.localReviewAgentSelections !== undefined || policy.localReviewAgents !== undefined)) {
    answers.reviewers = [...(policy.localReviewAgentSelections ?? policy.localReviewAgents ?? [])];
  } else if (policy?.reviewAgentSelections !== undefined || policy?.reviewAgents !== undefined) {
    answers.reviewers = [...(policy.reviewAgentSelections ?? policy.reviewAgents ?? [])];
  }
  if (policy?.reviewModelSelections !== undefined) {
    answers.reviewModels = [...policy.reviewModelSelections];
  } else if (policy?.reviewModels !== undefined) {
    answers.reviewModels = Object.entries(policy.reviewModels.review ?? {}).flatMap(([host, binding]) => (
      binding?.model ? [`${host}:${binding.model}`] : []
    ));
  }
  if (policy?.publisherIntent !== undefined) answers.publisher = policy.publisherIntent;
  else if (policy?.publisher?.mode !== undefined) answers.publisher = policy.publisher.mode;
  if (policy?.qualityControl !== undefined) answers.qualityControl = policy.qualityControl;
  if (policy?.manualUiAudit !== undefined) answers.manualUiAudit = policy.manualUiAudit;
  if (policy?.uiAuditEvidenceRoot !== undefined) answers.uiAuditEvidenceRoot = policy.uiAuditEvidenceRoot;
  if (policy?.instructions?.noCreditWarning !== undefined) answers.noCreditWarning = policy.instructions.noCreditWarning;
  return answers;
}

export function buildInitQuestions(input: {
  machine: GuideMachine;
  answers: InvocationAnswers;
  useDefaults?: boolean;
  repoRoot?: string | null;
  reviewProvider?: ReviewProviderKind;
}): InitQuestion[] {
  const recommendedMode = recommendedReviewMode(input.machine);
  const isolatedHosts = isolatedReviewHostsOnMachine(input.machine);
  const selectedMode = input.answers.reviewMode ?? recommendedMode;
  const modelHosts = reviewModelHostsForMode(input.machine, selectedMode);
  const recommendedAudit = recommendedManualUiAudit(input.machine);
  const qualityControlValue = recommendedQualityControl(input.machine);
  const recommendedPublisher: 'user' | 'github-app' | 'token' = 'user';
  const recommendedReviewers: string[] = [];
  const reviewerQuestion = reviewerQuestionFor(input.machine, selectedMode);
  const includeEvidenceRoot = input.answers.manualUiAudit === true
    || (input.answers.manualUiAudit !== false && recommendedAudit);

  const questions: InitQuestion[] = [
    question({
      id: 'review-mode',
      prompt: 'Which review mode should this repository use?',
      options: REVIEW_MODES.map(mode => ({
        value: mode,
        label: reviewModeLabel(mode),
        available: mode !== 'isolated' || isolatedHosts.length > 0,
      })),
      recommendation: recommendedMode === 'isolated'
        ? `Use isolated. Installed review host adapters on this machine: ${isolatedHosts.join(', ')}.`
        : 'Use external. No isolated review host adapter is installed on this machine.',
      recommendedValue: recommendedMode,
      answered: input.answers.reviewMode !== undefined,
      value: input.answers.reviewMode ?? null,
      reason: input.answers.reviewMode !== undefined
        ? 'The invocation already selected the review mode.'
        : 'Init recommends a mode from the hosts installed on this machine.',
    }),
    question({
      id: 'reviewers',
      prompt: reviewerQuestion.prompt,
      options: reviewerQuestion.options,
      recommendation: reviewerQuestion.recommendation,
      recommendedValue: recommendedReviewers,
      answered: input.answers.reviewers !== undefined,
      value: input.answers.reviewers ?? null,
      reason: input.answers.reviewers !== undefined
        ? 'The invocation already selected reviewers.'
        : 'Init recommends reviewers that match the selected review mode.',
    }),
    question({
      id: 'review-models',
      prompt: selectedMode === 'host'
        ? 'Which live harness models should native review use?'
        : 'Which live harness models should isolated review use?',
      options: liveModelOptions(input.machine, modelHosts),
      recommendation: liveModelRecommendation(input.machine, modelHosts),
      recommendedValue: liveModelRecommendationValue(input.machine, modelHosts),
      answered: input.answers.reviewModels !== undefined,
      value: input.answers.reviewModels ?? null,
      reason: input.answers.reviewModels !== undefined
        ? 'The invocation already selected review models.'
        : 'Init presents each host catalog so the agent can choose a model the host currently serves.',
    }),
    ...(input.reviewProvider === 'gitlab' ? [] : [question({
      id: 'publisher',
      prompt: 'Which identity should publish formal pull request reviews?',
      options: [
        { value: 'user', label: 'Own account. A review published by the pull request author is not a formal review.' },
        { value: 'github-app', label: 'GitHub App identity. Use this when the author and the publisher must differ.' },
        { value: 'token', label: 'Fine-grained token identity stored in an environment variable.' },
      ],
      recommendation: 'Use your own account unless an app or token identity is already configured. A user publisher that matches the pull request author cannot publish a formal review.',
      recommendedValue: recommendedPublisher,
      answered: input.answers.publisher !== undefined,
      value: input.answers.publisher ?? null,
      reason: input.answers.publisher !== undefined
        ? 'The invocation already selected the publisher identity.'
        : 'Init recommends a user publisher until review setup writes an app or token identity.',
    })]),
    question({
      id: 'quality-gate',
      prompt: 'Should Quality Control run?',
      options: [
        { value: 'off', label: 'Do not run AIQ quality gates.' },
        { value: 'on', label: 'Run configured AIQ quality gates. Requires aiq.' },
      ],
      recommendation: qualityControlValue
        ? 'Record Quality Control. AIQ is available, so lint and format become a pre-PR gate.'
        : 'Leave Quality Control off until aiq is available.',
      recommendedValue: qualityControlValue ? 'on' : 'off',
      answered: input.answers.qualityControl !== undefined,
      value: input.answers.qualityControl !== undefined ? (input.answers.qualityControl ? 'on' : 'off') : null,
      reason: input.answers.qualityControl !== undefined
        ? 'The invocation already selected Quality Control.'
        : qualityControlValue
          ? 'Init recommends Quality Control on when aiq is available.'
          : 'Init recommends Quality Control off until aiq is available.',
    }),
    question({
      id: 'ui-audit',
      prompt: 'Does this repository have user-facing UI that needs the manual audit policy?',
      options: [
        { value: 'true', label: 'Enable manual UI audit.' },
        { value: 'false', label: 'Disable manual UI audit.' },
      ],
      recommendation: recommendedAudit
        ? 'Enable manual UI audit. This repository looks like UI and agent-browser is on PATH.'
        : uiAuditRecommendation(input.machine),
      recommendedValue: recommendedAudit ? 'true' : 'false',
      answered: input.answers.manualUiAudit !== undefined,
      value: input.answers.manualUiAudit === undefined ? null : (input.answers.manualUiAudit ? 'true' : 'false'),
      reason: input.answers.manualUiAudit !== undefined
        ? 'The invocation already selected the UI audit policy.'
        : 'Init recommends UI audit only when the repository looks like UI and agent-browser is available.',
    }),
  ];
  if (includeEvidenceRoot) {
    questions.push(question({
      id: 'ui-audit-evidence',
      prompt: 'Where should this machine keep local UI audit evidence?',
      options: [
        { value: DEFAULT_UI_AUDIT_EVIDENCE_ROOT, label: 'QUBE user default (~/.qube/verification/)' },
        { value: 'custom', label: 'Custom directory that you supply' },
      ],
      recommendation: 'Use the QUBE user default ~/.qube/verification/.',
      recommendedValue: DEFAULT_UI_AUDIT_EVIDENCE_ROOT,
      answered: input.answers.uiAuditEvidenceRoot !== undefined,
      value: input.answers.uiAuditEvidenceRoot ?? null,
      reason: input.answers.uiAuditEvidenceRoot !== undefined
        ? 'The invocation or existing config already selected the UI audit evidence root.'
        : 'Init recommends the QUBE user default ~/.qube/verification/.',
    }));
  }
  questions.push(question({
    id: 'attribution-hygiene',
    prompt: 'Should installed agent instructions keep public git and GitHub writes on the human project identity?',
    options: [
      { value: 'true', label: 'Yes. Install attribution hygiene rules. Recommended when more than one model or harness will touch the repository.' },
      { value: 'false', label: 'No. Omit those rules from installed instructions.' },
    ],
    recommendation: 'Install attribution hygiene rules. Public git and GitHub writes then stay on the human project identity.',
    recommendedValue: 'true',
    answered: input.answers.noCreditWarning !== undefined,
    value: input.answers.noCreditWarning === undefined ? null : (input.answers.noCreditWarning ? 'true' : 'false'),
    reason: input.answers.noCreditWarning !== undefined
      ? 'The invocation already selected the attribution hygiene policy.'
      : 'Init recommends installing the rules so public history does not stamp uneven host credit.',
  }));
  return questions;
}

function uiAuditRecommendation(guide: GuideMachine): string {
  if (!guide.hasUserFacingUi) return 'Leave UI audit off. This repository does not look like user-facing UI.';
  return 'Leave UI audit off. This repository looks like UI, but agent-browser is not on PATH.';
}

function reviewerQuestionFor(machine: GuideMachine, mode: ReviewMode): Pick<InitQuestion, 'prompt' | 'options' | 'recommendation'> {
  if (mode === 'external') {
    return {
      prompt: 'Which external review services should the gate request?',
      options: (machine.externalReviewers ?? []).map(reviewer => ({
        value: reviewer.id,
        label: `${reviewer.label} (external service)`,
        available: true,
      })),
      recommendation: 'Leave external reviewers empty unless this repository already uses one of the listed services.',
    };
  }
  if (mode === 'host') {
    const hosts = machine.installedHosts.filter(host => getAgentHostProfileSync(host).review.local.support !== 'unsupported');
    return {
      prompt: 'Which installed agent harnesses should run native review subagents?',
      options: hosts.map(host => ({ value: host, label: `${getAgentHostProfileSync(host).displayName} subscription`, available: true })),
      recommendation: hosts.length > 0
        ? 'Use the primary agent harness, or select another installed harness to move review work to that subscription.'
        : 'No installed agent harness supports native review subagents.',
    };
  }
  return {
    prompt: 'Should isolated review request an external reviewer?',
    options: [],
    recommendation: 'Leave reviewers empty. Isolated review uses the selected live harness models.',
  };
}

function reviewModelHostsForMode(machine: GuideMachine, mode: ReviewMode): readonly ReviewModelHostId[] {
  if (mode === 'isolated') return isolatedReviewHostsOnMachine(machine);
  if (mode === 'host') {
    return machine.installedHosts.filter(host => getAgentHostProfileSync(host).review.local.support !== 'unsupported');
  }
  return [];
}

function liveModelOptions(machine: GuideMachine, hosts: readonly ReviewModelHostId[]): InitQuestionOption[] {
  const options = hosts.flatMap(host => (machine.liveModels?.[host] ?? []).map(model => ({
    value: `${host}:${model}`,
    label: `${host} currently serves ${model}.`,
    available: true,
  })));
  return options.length > 0 ? options : [{ value: 'none', label: 'No live host catalog is available.', available: false }];
}

function liveModelRecommendation(machine: GuideMachine, hosts: readonly ReviewModelHostId[]): string {
  const first = hosts.flatMap(host => (machine.liveModels?.[host] ?? []).map(model => `${host}:${model}`))[0];
  return first
    ? `Use a model from the live catalog. Example: ${first}.`
    : 'No live catalog is available. Leave review models unconfigured until a host can list models.';
}

function liveModelRecommendationValue(machine: GuideMachine, hosts: readonly ReviewModelHostId[]): string[] {
  const first = hosts.flatMap(host => (machine.liveModels?.[host] ?? []).map(model => `${host}:${model}`))[0];
  return first ? [first] : [];
}

function reviewModelsFromAnswers(values: string[]): NonNullable<InitPolicyOptions['reviewModels']> {
  const review: NonNullable<InitPolicyOptions['reviewModels']>['review'] = {};
  for (const value of values) {
    const separator = value.indexOf(':');
    if (separator <= 0) continue;
    const host = value.slice(0, separator);
    const model = value.slice(separator + 1).trim();
    if ((REVIEW_MODEL_HOST_IDS as readonly string[]).includes(host) && model) review[host as ReviewModelHostId] = { model, effort: null };
  }
  return { review, economy: {}, synthesis: {} };
}

function asEnabledFlag(value: InitQuestion['value']): boolean | null {
  if (value === true || value === 'true' || value === 'on') return true;
  if (value === false || value === 'false' || value === 'off') return false;
  return null;
}

function question(input: InitQuestion): InitQuestion {
  return input;
}

function reviewModeLabel(mode: ReviewMode): string {
  if (mode === 'external') return 'external: a review service reviews the pull request.';
  if (mode === 'host') return 'host: the coding agent runs one review subagent per lane.';
  return 'isolated: Executor runs model CLIs for the lane batch.';
}

export function fillUnansweredQuestions(questions: InitQuestion[]): InitQuestion[] {
  return questions.map(item => (
    item.answered
      ? item
      : { ...item, answered: true, value: item.recommendedValue, reason: `${item.reason} Init filled the recommended value.` }
  ));
}

export function unansweredQuestionIds(questions: InitQuestion[]): InitQuestionId[] {
  return questions.filter(item => !item.answered).map(item => item.id);
}

export function applyQuestionAnswersToPolicy(policy: InitPolicyOptions, questions: InitQuestion[]): InitPolicyOptions {
  const next: InitPolicyOptions = { ...policy };
  for (const item of questions) {
    if (!item.answered) continue;
    if (item.id === 'review-mode' && isReviewMode(item.value) && next.reviewMode === undefined) next.reviewMode = item.value;
    if (item.id === 'reviewers' && Array.isArray(item.value)) {
      const reviewers = item.value.filter(value => !value.includes(':'));
      if (next.reviewMode === 'host' && next.localReviewAgents === undefined) next.localReviewAgents = reviewers;
      else if (next.reviewMode !== 'host' && next.reviewAgents === undefined) next.reviewAgents = reviewers;
    }
    if (item.id === 'review-models' && Array.isArray(item.value) && next.reviewModels === undefined) {
      const mapped = reviewModelsFromAnswers(item.value);
      if (Object.keys(mapped.review).length > 0) next.reviewModels = mapped;
    }
    const usesGitHubReview = next.reviewProvider === 'github' || (next.reviewProvider === undefined && (next.workProvider === undefined || next.workProvider === 'github'));
    if (item.id === 'publisher' && usesGitHubReview && (item.value === 'user' || item.value === 'github-app' || item.value === 'token') && next.publisher === undefined) {
      if (item.value === 'user') next.publisher = { mode: 'user' };
      if (item.value === 'github-app') next.publisherIntent = 'github-app';
      // Token publishers require an environment-variable reference from --from or review setup.
    }
    if (item.id === 'quality-gate' && next.qualityControl === undefined) {
      const enabled = asEnabledFlag(item.value);
      if (enabled !== null) next.qualityControl = enabled;
    }
    if (item.id === 'ui-audit' && next.manualUiAudit === undefined) {
      const enabled = asEnabledFlag(item.value);
      if (enabled !== null) next.manualUiAudit = enabled;
    }
    if (item.id === 'ui-audit-evidence' && next.uiAuditEvidenceRoot === undefined) {
      const mapped = mapEvidenceRootAnswer(item.value);
      if (mapped !== null) next.uiAuditEvidenceRoot = mapped;
    }
    if (item.id === 'attribution-hygiene' && next.instructions?.noCreditWarning === undefined) {
      const enabled = asEnabledFlag(item.value);
      if (enabled !== null) next.instructions = { ...next.instructions, noCreditWarning: enabled };
    }
  }
  return next;
}

function mapEvidenceRootAnswer(value: InitQuestion['value']): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === 'custom') return null;
  if (trimmed === 'qube' || trimmed === DEFAULT_UI_AUDIT_EVIDENCE_ROOT) return DEFAULT_UI_AUDIT_EVIDENCE_ROOT;
  if (trimmed.split(/[\\/]+/).some(segment => segment === '..')) return null;
  if (trimmed.startsWith('~') || isAbsolute(trimmed)) return trimmed;
  return null;
}

export function buildSetupSummary(input: {
  reviewMode: ReviewMode;
  reviewers: string[];
  publisher: string;
  qualityControl: boolean;
  manualUiAudit: boolean;
  tools: InitTool[];
}): InitSetupSummary {
  return {
    reviewMode: input.reviewMode,
    reviewers: [...input.reviewers],
    publisher: input.publisher,
    qualityControl: input.qualityControl,
    manualUiAudit: input.manualUiAudit,
    tools: [...input.tools],
  };
}
