import type { GitLabReviewPermissionDiagnosis } from '@tjalve/qube-adapter-gitlab';
import type { Config } from './config/index.js';
import type { GitHubReviewPublisherIdentity } from '@tjalve/qube-adapter-github';
import { adapterInstallAndInitGuidance, isMissingAdapterPackage } from './missing_adapter_package.js';
import {
  REVIEW_PUBLISHER_ROLE_BOUNDARY,
  type ReviewDoctorResult,
  type ReviewPublisherProbe,
} from './review_setup.js';

export type GitLabReviewDoctorProber = () => Promise<GitLabReviewPermissionDiagnosis>;

function notRunProbe(): ReviewPublisherProbe {
  return {
    attempted: false,
    status: 'not-run',
    permissionStatus: null,
    formalEventCapability: null,
    fallbackReason: null,
    repository: {
      attempted: false,
      status: 'not-run',
      repository: null,
      accessible: false,
      pullRequestPermission: 'unknown',
      fallbackReason: null,
    },
    avatar: {
      attempted: false,
      status: 'not-run',
      botAvatarUrl: null,
      ownerAvatarUrl: null,
      ownerFallback: null,
    },
    contentsPermission: 'not-run',
  };
}

function readinessFor(diagnosis: GitLabReviewPermissionDiagnosis): ReviewDoctorResult['readiness'] {
  if (!diagnosis.tokenPresent) return 'unconfigured';
  if (diagnosis.apiScope === 'missing') return 'unavailable';
  if (diagnosis.approvalPermission === 'missing') return 'degraded';
  if (diagnosis.apiScope === 'ok' && diagnosis.approvalPermission === 'ok') return 'ready';
  return 'degraded';
}

function nextActionFor(diagnosis: GitLabReviewPermissionDiagnosis): string {
  if (!diagnosis.tokenPresent) {
    return 'Set GITLAB_TOKEN to a project or group access token with api scope, then rerun `review doctor --json`.';
  }
  if (diagnosis.apiScope === 'missing') {
    return 'Create a project or group access token with api scope and set GITLAB_TOKEN, then rerun `review doctor --json`.';
  }
  if (diagnosis.approvalPermission === 'missing') {
    return 'Grant the GitLab token a role that may approve merge requests, then rerun `review doctor --json`.';
  }
  if (diagnosis.apiScope === 'ok' && diagnosis.approvalPermission === 'ok') {
    return 'GitLab review publisher is ready. Continue using host-run review agents and publish their results through the configured GitLab identity.';
  }
  return diagnosis.failure ?? 'Verify GITLAB_TOKEN, GITLAB_PROJECT_ID, api scope, and merge request approval permission, then rerun `review doctor --json`.';
}

export async function runGitLabReviewDoctor(options: {
  readonly config: Config | null;
  readonly cwd?: string;
  readonly mintProbe?: boolean;
  readonly probeGitLabReview?: GitLabReviewDoctorProber;
}): Promise<ReviewDoctorResult> {
  const tokenPresent = Boolean((process.env.GITLAB_TOKEN ?? '').trim());
  const projectId = options.config?.providers.connections.gitlab?.projectId
    ?? options.config?.providers.review.connection?.projectId
    ?? process.env.GITLAB_PROJECT_ID;
  const attempted = Boolean(options.probeGitLabReview) || (options.mintProbe === true && tokenPresent);
  let diagnosis: GitLabReviewPermissionDiagnosis = {
    login: null,
    tokenPresent,
    apiScope: tokenPresent ? 'unknown' : 'missing',
    approvalPermission: tokenPresent ? 'unknown' : 'missing',
    failure: tokenPresent ? null : 'GITLAB_TOKEN is not set. Set a project or group access token with api scope.',
  };
  if (options.probeGitLabReview) {
    diagnosis = await options.probeGitLabReview();
  } else if (attempted) {
    try {
      const imported = await import('@tjalve/qube-adapter-gitlab');
      const provider = imported.createGitLabReviewForgeProvider({
        token: process.env.GITLAB_TOKEN,
        projectId: typeof projectId === 'string' ? projectId : process.env.GITLAB_PROJECT_ID,
        baseUrl: process.env.GITLAB_BASE_URL,
      });
      diagnosis = await provider.diagnoseReviewPermissions();
    } catch (error) {
      const missingAdapter = isMissingAdapterPackage(error, '@tjalve/qube-adapter-gitlab');
      diagnosis = {
        login: null,
        tokenPresent: missingAdapter ? tokenPresent : true,
        apiScope: missingAdapter && !tokenPresent ? 'missing' : 'unknown',
        approvalPermission: missingAdapter && !tokenPresent ? 'missing' : 'unknown',
        failure: missingAdapter
          ? `GitLab review doctor requires optional adapter @tjalve/qube-adapter-gitlab. ${adapterInstallAndInitGuidance('@tjalve/qube-adapter-gitlab', '--work-provider gitlab')}`
          : error instanceof Error ? error.message : String(error),
      };
    }
  }
  const readiness = readinessFor(diagnosis);
  const permissionStatus: GitHubReviewPublisherIdentity['permissionStatus'] = !diagnosis.tokenPresent
    ? 'unconfigured'
    : diagnosis.apiScope === 'missing'
      ? 'missing'
      : diagnosis.approvalPermission === 'missing'
        ? 'missing'
        : diagnosis.apiScope === 'ok'
          ? 'ok'
          : 'misconfigured';
  const probe = attempted
    ? {
      attempted: true,
      status: readiness === 'ready' ? 'ok' as const : readiness === 'unavailable' ? 'failed' as const : 'degraded' as const,
      permissionStatus,
      formalEventCapability: diagnosis.approvalPermission === 'ok',
      fallbackReason: diagnosis.failure,
      repository: {
        attempted: true,
        status: diagnosis.approvalPermission === 'ok' ? 'ok' as const : diagnosis.approvalPermission === 'missing' ? 'failed' as const : 'degraded' as const,
        repository: typeof projectId === 'string' ? projectId : null,
        accessible: diagnosis.apiScope !== 'missing',
        pullRequestPermission: diagnosis.approvalPermission === 'ok' ? 'write' as const : diagnosis.approvalPermission === 'missing' ? 'read' as const : 'unknown' as const,
        fallbackReason: diagnosis.failure,
      },
      avatar: notRunProbe().avatar,
      contentsPermission: 'not-run' as const,
    }
    : notRunProbe();
  return {
    ok: true,
    command: 'review doctor',
    publisherSource: 'repository',
    publisherFieldSources: Object.freeze({}),
    readiness,
    mode: 'token',
    identityClass: diagnosis.tokenPresent ? 'fine-grained-token' : 'none',
    login: diagnosis.login,
    permissionStatus,
    formalEventCapability: diagnosis.approvalPermission === 'ok',
    fallbackReason: diagnosis.failure,
    missingFields: [
      ...(!diagnosis.tokenPresent ? ['GITLAB_TOKEN'] : []),
      ...(diagnosis.apiScope === 'missing' ? ['api scope'] : []),
      ...(diagnosis.approvalPermission === 'missing' ? ['merge request approval permission'] : []),
    ],
    secretReferences: {},
    probe,
    nextAction: nextActionFor(diagnosis),
    roleBoundary: REVIEW_PUBLISHER_ROLE_BOUNDARY,
  };
}
