import {
  extractFindingFingerprints,
  loginsMatch,
  planReviewThreadLifecycle,
  type ReviewDiffIndex,
  type ReviewFinding,
  type ReviewFindingSide,
  type ReviewFindingThread,
  type ReviewRoundStatusLane,
  type ReviewRoundSummaryPublishInput,
  type ReviewThreadLifecycleAction,
} from "@tjalve/qube-core";
import type {
  GitLabDiffRefs,
  GitLabDiscussion,
  GitLabDiscussionPosition,
  GitLabMergeRequestDiff,
  GitLabNote,
} from "./gitlab_review_types.js";

export const ROUND_SUMMARY_MARKER_PREFIX = "qube-pr-review-summary";
export const ROUND_STATUS_MARKER_PREFIX = "qube-pr-status";

export interface GitLabStatusRound {
  readonly head: string;
  readonly verdict: string;
  readonly complete?: boolean;
  readonly lanes?: readonly ReviewRoundStatusLane[];
}

function statusCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function statusReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = redactStatusReason(value).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return normalized === "" ? null : normalized.slice(0, 240);
}

function redactStatusReason(value: string): string {
  return value
    .replace(/\b(?:ghp_|github_pat_|ghs_|gho_|ghu_)[A-Za-z0-9_]{10,}\b/g, "[REDACTED]")
    .replace(/\bglpat-[A-Za-z0-9_-]{10,}\b/g, "[REDACTED]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s'"`]+/gi, "$1[REDACTED]")
    .replace(/\b([A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|password|passwd|pwd|client[_-]?secret|access[_-]?token)[A-Za-z0-9_.-]*)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|`[^`]*`|[^\s,;&)]+)/gi, "$1$2[REDACTED]")
    .replace(/\\\\[A-Za-z0-9._$-]+\\[^\r\n)<>]+/g, "[local-path]")
    .replace(/\b[A-Za-z]:[\\/][^\r\n)<>]+/g, "[local-path]")
    .replace(/(^|[\s(:`"'])\/(?:Users|home|tmp|var|private|mnt|Volumes|workspace|workspaces|code)\/[^\r\n)<>]+/g, "$1[local-path]");
}

function renderStatusText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/@/g, "&#64;");
}

function parseStatusLane(value: unknown): ReviewRoundStatusLane | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.laneId !== "string" || record.laneId.trim() === "") return null;
  const allowed = new Set(["passed", "needs-work", "failed", "missing", "pending", "unavailable", "invalid"]);
  if (typeof record.status !== "string" || !allowed.has(record.status)) return null;
  return {
    laneId: record.laneId.trim(),
    status: record.status as ReviewRoundStatusLane["status"],
    blockingFindingCount: statusCount(record.blockingFindingCount),
    advisoryFindingCount: statusCount(record.advisoryFindingCount),
    reason: statusReason(record.reason),
  };
}

export function normalizeStatusLanes(lanes: readonly ReviewRoundStatusLane[]): ReviewRoundStatusLane[] | null {
  const normalized = lanes.map(parseStatusLane).filter((lane): lane is ReviewRoundStatusLane => lane !== null);
  return normalized.length === lanes.length ? normalized : null;
}

export function discussionPosition(input: {
  readonly diffRefs: GitLabDiffRefs | null | undefined;
  readonly path: string;
  readonly oldPath?: string;
  readonly line: number;
  readonly side?: "source" | "destination";
}): GitLabDiscussionPosition | null {
  const baseSha = input.diffRefs?.base_sha?.trim() ?? "";
  const startSha = input.diffRefs?.start_sha?.trim() ?? "";
  const headSha = input.diffRefs?.head_sha?.trim() ?? "";
  if (baseSha === "" || startSha === "" || headSha === "" || input.path.trim() === "") return null;
  const newPath = input.path.trim();
  const oldPath = (input.oldPath ?? input.path).trim();
  if (input.side === "source") {
    return {
      base_sha: baseSha,
      start_sha: startSha,
      head_sha: headSha,
      position_type: "text",
      old_path: oldPath,
      new_path: newPath,
      old_line: input.line,
    };
  }
  return {
    base_sha: baseSha,
    start_sha: startSha,
    head_sha: headSha,
    position_type: "text",
    old_path: oldPath,
    new_path: newPath,
    new_line: input.line,
  };
}

export function parseRoundSummaryMarker(body: string | null | undefined): {
  readonly head: string;
  readonly round: string;
  readonly prNumber: number;
  readonly findingDigest: string;
  readonly superseded: boolean;
} | null {
  const match = (body ?? "").match(/<!--\s*qube-pr-review-summary:(\{[\s\S]*?\})\s*-->/);
  if (!match?.[1]) return null;
  try {
    const parsed = JSON.parse(match[1]) as Record<string, unknown>;
    if (typeof parsed.head !== "string" || parsed.head.trim() === "") return null;
    if (typeof parsed.round !== "string" || parsed.round.trim() === "") return null;
    if (typeof parsed.prNumber !== "number") return null;
    return {
      head: parsed.head,
      round: parsed.round,
      prNumber: parsed.prNumber,
      findingDigest: typeof parsed.findingDigest === "string" ? parsed.findingDigest : "",
      superseded: parsed.superseded === true,
    };
  } catch {
    return null;
  }
}

export function parseStatusNoteRounds(body: string | null | undefined): GitLabStatusRound[] {
  const text = body ?? "";
  const prefix = "<!-- qube-pr-status:";
  const start = text.indexOf(prefix);
  if (start < 0) return [];
  const jsonStart = start + prefix.length;
  const end = text.indexOf(" -->", jsonStart);
  if (end < 0) return [];
  try {
    const parsed: unknown = JSON.parse(text.slice(jsonStart, end));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray((parsed as { rounds?: unknown }).rounds)) return [];
    return (parsed as { rounds: unknown[] }).rounds
      .filter((entry): entry is Record<string, unknown> & { head: string; verdict: string } => (
        !!entry && typeof entry === "object" && !Array.isArray(entry)
        && typeof (entry as { head?: unknown }).head === "string"
        && (entry as { head: string }).head.trim() !== ""
        && typeof (entry as { verdict?: unknown }).verdict === "string"
      ))
      .map((entry) => {
        const lanes = Array.isArray(entry.lanes) ? entry.lanes.map(parseStatusLane).filter((lane): lane is ReviewRoundStatusLane => lane !== null) : [];
        return {
          head: entry.head,
          verdict: entry.verdict,
          ...(entry.complete === true ? { complete: true } : {}),
          ...(lanes.length > 0 ? { lanes } : {}),
        };
      })
      .slice(-20);
  } catch {
    return [];
  }
}

export function renderStatusNote(rounds: ReadonlyArray<GitLabStatusRound>, prNumber?: number): string {
  const latest = rounds.at(-1);
  const latestLanes = latest?.lanes ?? [];
  const validatedCount = latestLanes.filter((lane) => lane.status === "passed" || lane.status === "needs-work" || lane.status === "failed").length;
  const blockingCount = latestLanes.reduce((sum, lane) => sum + lane.blockingFindingCount, 0);
  const advisoryCount = latestLanes.reduce((sum, lane) => sum + lane.advisoryFindingCount, 0);
  const markerPayload = JSON.stringify({ version: 1, ...(prNumber ? { prNumber } : {}), rounds: rounds.slice(-20) }).replace(/--/g, "\\u002d\\u002d");
  const history = rounds.map((round) => {
    const lanes = round.lanes ?? [];
    const validated = lanes.filter((lane) => lane.status === "passed" || lane.status === "needs-work" || lane.status === "failed").length;
    const blocking = lanes.reduce((sum, lane) => sum + lane.blockingFindingCount, 0);
    const advisory = lanes.reduce((sum, lane) => sum + lane.advisoryFindingCount, 0);
    const summary = lanes.length > 0 ? ` — ${validated}/${lanes.length} validated, ${blocking} blocking, ${advisory} advisory` : "";
    const details = lanes.map((lane) => `  - ${renderStatusText(lane.laneId)}: ${lane.status}${lane.reason ? ` — ${renderStatusText(lane.reason)}` : ""}`).join("\n");
    return `- ${round.head.slice(0, 12)}: ${round.verdict}${round.complete ? " (complete)" : ""}${summary}${details ? `\n${details}` : ""}`;
  }).join("\n");
  return [
    `<!-- ${ROUND_STATUS_MARKER_PREFIX}:${markerPayload} -->`,
    "",
    latest ? `Review status: ${latest.verdict}.` : "Review status: pending.",
    latest ? `Head: ${latest.head}.` : "",
    ...(latestLanes.length > 0 ? [`Validated lanes: ${validatedCount}/${latestLanes.length}.`, `Findings: ${blockingCount} blocking, ${advisoryCount} advisory.`, "", "Lane status", ...latestLanes.map((lane) => `- ${renderStatusText(lane.laneId)}: ${lane.status} — ${lane.blockingFindingCount} blocking, ${lane.advisoryFindingCount} advisory${lane.reason ? ` — ${renderStatusText(lane.reason)}` : ""}`)] : []),
    "",
    "<details>",
    "<summary>Round history</summary>",
    "",
    history || "No prior rounds.",
    "",
    "</details>",
    "",
    typeof prNumber === "number" ? `Rerun: \`aie pr gate ${prNumber}\`.` : "",
  ].filter((line) => line !== undefined).join("\n");
}

export function classifyGitLabPublishError(error: unknown, kind: "approve" | "publish" = "publish"): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/HTTP 401/.test(message)) {
    return `GitLab token is missing the api scope or is invalid. ${message}`;
  }
  if (/HTTP 403/.test(message) && kind === "approve") {
    return `GitLab approval permission is missing. The configured token cannot approve or revoke approval on this merge request. ${message}`;
  }
  return message;
}

export function isBenignApprovalStateError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already approved|not approved|has not approved|HTTP 409|HTTP 304/i.test(message);
}

function normalizeDiffPath(path: string): string {
  return path.replace(/^[ab]\//, "").replace(/^\/+/, "");
}

export function parseGitLabDiffIndex(diffs: readonly GitLabMergeRequestDiff[]): ReviewDiffIndex {
  const destinationLinesByPath = new Map<string, Set<number>>();
  const sourceLinesByPath = new Map<string, Set<number>>();
  for (const file of diffs) {
    const destinationPath = file.new_path ? normalizeDiffPath(file.new_path) : null;
    const sourcePath = file.old_path ? normalizeDiffPath(file.old_path) : null;
    if (destinationPath && !destinationLinesByPath.has(destinationPath)) destinationLinesByPath.set(destinationPath, new Set());
    if (sourcePath && !sourceLinesByPath.has(sourcePath)) sourceLinesByPath.set(sourcePath, new Set());
    let oldLine = 0;
    let newLine = 0;
    for (const line of (file.diff ?? "").split(/\r?\n/)) {
      const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) {
        oldLine = Number.parseInt(hunk[1], 10);
        newLine = Number.parseInt(hunk[2], 10);
        continue;
      }
      if (oldLine <= 0 && newLine <= 0) continue;
      if (line.startsWith("+")) {
        if (destinationPath && newLine > 0) destinationLinesByPath.get(destinationPath)?.add(newLine);
        newLine += 1;
      } else if (line.startsWith("-")) {
        if (sourcePath && oldLine > 0) sourceLinesByPath.get(sourcePath)?.add(oldLine);
        oldLine += 1;
      } else if (line.startsWith("\\")) {
        continue;
      } else {
        if (destinationPath && newLine > 0) destinationLinesByPath.get(destinationPath)?.add(newLine);
        if (sourcePath && oldLine > 0) sourceLinesByPath.get(sourcePath)?.add(oldLine);
        oldLine += 1;
        newLine += 1;
      }
    }
  }
  return {
    hasLine(path: string, line: number, side: ReviewFindingSide = "destination"): boolean {
      const linesByPath = side === "source" ? sourceLinesByPath : destinationLinesByPath;
      return linesByPath.get(normalizeDiffPath(path))?.has(line) ?? false;
    },
  };
}

export function renamedOldPath(diffs: readonly GitLabMergeRequestDiff[], path: string): string {
  const normalized = normalizeDiffPath(path);
  const match = diffs.find((file) => file.renamed_file === true && file.new_path && normalizeDiffPath(file.new_path) === normalized);
  return match?.old_path ? normalizeDiffPath(match.old_path) : normalized;
}

export function findingThreadsFromDiscussions(
  discussions: readonly GitLabDiscussion[],
  publisherLogins: readonly string[],
): ReviewFindingThread[] {
  return discussions.flatMap((discussion) => {
    const notes = discussion.notes ?? [];
    if (notes.length === 0) return [];
    const first = notes[0];
    const authorLogin = first.author?.username ?? first.author?.name ?? null;
    const resolvable = notes.some((note) => note.resolvable === true);
    const resolved = resolvable && notes.every((note) => !note.resolvable || note.resolved === true);
    const outdated = notes.some((note) => note.position?.outdated === true);
    const reply = [...notes].reverse().find((note) => typeof note.id === "number");
    return [{
      threadId: discussion.id,
      resolved,
      outdated,
      canResolve: resolvable,
      authorLogin,
      fingerprints: [...new Set(notes.flatMap((note) => extractFindingFingerprints(note.body)))],
      replyToDatabaseId: reply?.id ?? null,
      minimizeSubjectId: null,
    }];
  }).filter((thread) => publisherLogins.some((login) => loginsMatch(thread.authorLogin, login)));
}

export function planGitLabThreadLifecycle(input: {
  readonly findings: readonly ReviewFinding[];
  readonly discussions: readonly GitLabDiscussion[];
  readonly publisherLogins: readonly string[];
  readonly headSha: string;
  readonly round: string;
  readonly dispositions?: Readonly<Record<string, string>>;
}): ReviewThreadLifecycleAction[] {
  return planReviewThreadLifecycle({
    findings: input.findings,
    threads: findingThreadsFromDiscussions(input.discussions, input.publisherLogins),
    publisherLogins: input.publisherLogins,
    headSha: input.headSha,
    round: input.round,
    dispositions: input.dispositions,
  });
}

export function summaryNoteBody(input: ReviewRoundSummaryPublishInput): string {
  return input.body;
}
