import { FINDING_MARKER_PREFIX, reviewFindingFingerprint } from "./review_body.js";
import type { ReviewFinding } from "./review_forge.js";

const FINDING_MARKER_PATTERN = new RegExp(`<!-- ${FINDING_MARKER_PREFIX}:([a-f0-9]{16}) -->`, "g");

export interface ReviewFindingThread {
  readonly threadId: string;
  readonly resolved: boolean;
  readonly outdated: boolean;
  readonly canResolve: boolean;
  readonly authorLogin: string | null;
  readonly fingerprints: readonly string[];
  readonly replyToDatabaseId: number | null;
  readonly minimizeSubjectId: string | null;
}

export type ReviewThreadLifecycleKind =
  | "reply-still-present"
  | "new-inline"
  | "resolve"
  | "minimize-outdated";

export interface ReviewThreadLifecycleAction {
  readonly kind: ReviewThreadLifecycleKind;
  readonly threadId: string | null;
  readonly fingerprint: string | null;
  readonly replyToDatabaseId: number | null;
  readonly minimizeSubjectId: string | null;
  readonly unresolve: boolean;
  readonly body: string | null;
  readonly finding: ReviewFinding | null;
}

export interface PlanReviewThreadLifecycleInput {
  readonly findings: readonly ReviewFinding[];
  readonly threads: readonly ReviewFindingThread[];
  readonly publisherLogins: readonly string[];
  readonly headSha: string;
  readonly round: string;
  readonly dispositions?: Readonly<Record<string, string>>;
}

export function extractFindingFingerprints(body: string | null | undefined): string[] {
  if (typeof body !== "string" || body === "") return [];
  const found = new Set<string>();
  FINDING_MARKER_PATTERN.lastIndex = 0;
  for (const match of body.matchAll(FINDING_MARKER_PATTERN)) {
    if (match[1]) found.add(match[1]);
  }
  return [...found];
}

export function loginsMatch(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false;
  return left.trim().replace(/^@/, "").toLowerCase() === right.trim().replace(/^@/, "").toLowerCase();
}

export function isPublisherAuthoredThread(
  thread: ReviewFindingThread,
  publisherLogins: readonly string[],
): boolean {
  return publisherLogins.some((login) => loginsMatch(thread.authorLogin, login));
}

function shortHead(headSha: string): string {
  return headSha.trim().slice(0, 12);
}

export function stillPresentReply(headSha: string, round: string, detail?: string | null): string {
  const lead = `Still present at \`${shortHead(headSha)}\` (round ${round}).`;
  const extra = typeof detail === "string" && detail.trim() !== "" ? `\n\n${detail.trim()}` : "";
  return `${lead}${extra}`;
}

export function fixedClosingReply(headSha: string, round: string): string {
  return `Fixed in \`${shortHead(headSha)}\` — resolved by round ${round}.`;
}

export function dispositionClosingReply(disposition: string, round: string): string {
  const text = disposition.trim();
  return text === "" ? `Dropped — resolved by round ${round}.` : `${text} — resolved by round ${round}.`;
}

export function planReviewThreadLifecycle(input: PlanReviewThreadLifecycleInput): ReviewThreadLifecycleAction[] {
  const publisherThreads = input.threads.filter((thread) => isPublisherAuthoredThread(thread, input.publisherLogins));
  const currentByFingerprint = new Map<string, ReviewFinding>();
  for (const finding of input.findings) {
    currentByFingerprint.set(reviewFindingFingerprint(finding), finding);
  }
  const claimedThreads = new Set<string>();
  const threadsByFingerprint = new Map<string, ReviewFindingThread>();
  for (const candidate of publisherThreads) {
    for (const fingerprint of candidate.fingerprints) {
      if (!threadsByFingerprint.has(fingerprint)) threadsByFingerprint.set(fingerprint, candidate);
    }
  }
  const actions: ReviewThreadLifecycleAction[] = [];

  for (const [fingerprint, finding] of currentByFingerprint) {
    const thread = threadsByFingerprint.get(fingerprint);
    if (!thread || claimedThreads.has(thread.threadId)) {
      actions.push({
        kind: "new-inline",
        threadId: null,
        fingerprint,
        replyToDatabaseId: null,
        minimizeSubjectId: null,
        unresolve: false,
        body: null,
        finding,
      });
      continue;
    }
    claimedThreads.add(thread.threadId);
    if (thread.outdated && !finding.location) {
      actions.push({
        kind: "resolve",
        threadId: thread.threadId,
        fingerprint,
        replyToDatabaseId: thread.replyToDatabaseId,
        minimizeSubjectId: thread.minimizeSubjectId,
        unresolve: false,
        body: `Anchor is moot at \`${shortHead(input.headSha)}\` — resolved by round ${input.round}.`,
        finding,
      });
      continue;
    }
    if (thread.outdated && !thread.canResolve) {
      if (thread.minimizeSubjectId) {
        actions.push({
          kind: "minimize-outdated",
          threadId: thread.threadId,
          fingerprint,
          replyToDatabaseId: thread.replyToDatabaseId,
          minimizeSubjectId: thread.minimizeSubjectId,
          unresolve: false,
          body: null,
          finding: null,
        });
      }
      if (thread.replyToDatabaseId == null) {
        actions.push({
          kind: "new-inline",
          threadId: null,
          fingerprint,
          replyToDatabaseId: null,
          minimizeSubjectId: null,
          unresolve: false,
          body: null,
          finding,
        });
        continue;
      }
    }
    const locationNote = finding.location
      ? `${finding.location.path}${finding.location.line ? `:${finding.location.line}` : ""}`
      : null;
    actions.push({
      kind: "reply-still-present",
      threadId: thread.threadId,
      fingerprint,
      replyToDatabaseId: thread.replyToDatabaseId,
      minimizeSubjectId: thread.minimizeSubjectId,
      unresolve: thread.resolved,
      body: stillPresentReply(input.headSha, input.round, [finding.message, locationNote].filter(Boolean).join(" ")),
      finding,
    });
  }

  for (const thread of publisherThreads) {
    if (claimedThreads.has(thread.threadId)) continue;
    const fingerprint = thread.fingerprints[0] ?? null;
    const disposition = fingerprint ? input.dispositions?.[fingerprint] : undefined;
    if (thread.resolved) {
      if (thread.outdated && thread.minimizeSubjectId) {
        actions.push({
          kind: "minimize-outdated",
          threadId: thread.threadId,
          fingerprint,
          replyToDatabaseId: thread.replyToDatabaseId,
          minimizeSubjectId: thread.minimizeSubjectId,
          unresolve: false,
          body: null,
          finding: null,
        });
      }
      continue;
    }
    if (!thread.canResolve) {
      if (thread.minimizeSubjectId) {
        actions.push({
          kind: "minimize-outdated",
          threadId: thread.threadId,
          fingerprint,
          replyToDatabaseId: thread.replyToDatabaseId,
          minimizeSubjectId: thread.minimizeSubjectId,
          unresolve: false,
          body: null,
          finding: null,
        });
      }
      continue;
    }
    actions.push({
      kind: "resolve",
      threadId: thread.threadId,
      fingerprint,
      replyToDatabaseId: thread.replyToDatabaseId,
      minimizeSubjectId: thread.minimizeSubjectId,
      unresolve: false,
      body: disposition
        ? dispositionClosingReply(disposition, input.round)
        : fixedClosingReply(input.headSha, input.round),
      finding: null,
    });
  }

  return actions;
}
