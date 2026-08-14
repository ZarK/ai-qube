import { createHash } from "node:crypto";
import type { ReviewFinding } from "./review_forge.js";

export type ReviewRoundVerdict = "approve" | "request-changes" | "pending" | "inconclusive";
export type ReviewLaneRenderState = "approved" | "request-changes" | "inconclusive" | "reused" | "carried" | "not-run";
export type ReviewPublishTransport = "review-api" | "issue-comment";
export type ReviewSuggestionFenceKind = "github" | "none";

export const CLEAN_ROUND_PHRASE = "No issues found";
export const DEGRADED_TRANSPORT_LABEL = "issue-comment transport";

export interface ReviewRenderCapabilityProfile {
  readonly id: "github" | "degraded";
  readonly alerts: boolean;
  readonly collapsedSections: boolean;
  readonly suggestionFence: ReviewSuggestionFenceKind;
  readonly sanitizeText?: (value: string) => string;
}

export const GITHUB_REVIEW_RENDER_PROFILE: ReviewRenderCapabilityProfile = Object.freeze({
  id: "github",
  alerts: true,
  collapsedSections: true,
  suggestionFence: "github",
});

export const DEGRADED_REVIEW_RENDER_PROFILE: ReviewRenderCapabilityProfile = Object.freeze({
  id: "degraded",
  alerts: false,
  collapsedSections: false,
  suggestionFence: "none",
});

export interface ReviewRepositoryRef {
  readonly owner: string;
  readonly name: string;
}

export interface ReviewLaneRenderInput {
  readonly laneId: string;
  readonly status: string;
  readonly recommendation: ReviewRoundVerdict;
  readonly summary: string;
  readonly findings: readonly ReviewFinding[];
  readonly preconditions?: readonly string[];
  readonly evidenceHeadSha: string;
  readonly carriedForwardFromHeadSha: string | null;
  readonly origin?: "local" | "trusted-provider";
  readonly notRunReason?: string | null;
  readonly withheld?: { readonly duplicates: number; readonly offDiff: number; readonly byCap: number };
  readonly host?: string;
  readonly profile?: string;
  readonly evidencePath?: string;
}

export interface ReviewFindingRenderRow {
  readonly laneId: string;
  readonly finding: ReviewFinding;
  readonly anchored: boolean;
  readonly unanchoredReason: string | null;
}

export interface ReviewRoundDeltaInput {
  readonly priorHeadSha: string;
  readonly priorFindingKeys: readonly string[];
  readonly commitRange?: string;
}

export interface ReviewRoundRenderInput {
  readonly marker: string;
  readonly verdict: ReviewRoundVerdict;
  readonly headSha: string;
  readonly expectedLanes: readonly string[];
  readonly lanes: readonly ReviewLaneRenderInput[];
  readonly findings: readonly ReviewFindingRenderRow[];
  readonly transport: ReviewPublishTransport;
  readonly roundOrdinal?: number;
  readonly repository?: ReviewRepositoryRef;
  readonly priorRound?: ReviewRoundDeltaInput;
  readonly rerunCommand?: string;
  readonly publisherDowngradeReason?: string | null;
}

export interface ReviewLaneBodyRenderInput {
  readonly marker: string;
  readonly lane: ReviewLaneRenderInput;
  readonly bodyFindings: readonly ReviewFinding[];
  readonly inlineCount: number;
  readonly transport: ReviewPublishTransport;
  readonly headSha: string;
  readonly completeness?: string | null;
  readonly repository?: ReviewRepositoryRef;
}

export interface ReviewRenderedBody {
  readonly body: string;
  readonly marker: string;
}

export interface ReviewRoundDelta {
  readonly fixed: number;
  readonly unchanged: number;
  readonly added: number;
  readonly range: string;
  readonly clean: boolean;
}

const MAX_SUGGESTION_SPAN_LINES = 40;
const MAX_SUGGESTION_LENGTH = 2000;
const VERDICT_TRUNCATE_CHARS = 180;

function sanitize(profile: ReviewRenderCapabilityProfile, value: string): string {
  const text = profile.sanitizeText ? profile.sanitizeText(value) : value;
  return text.replace(/\r\n/g, "\n").trim();
}

function shortHead(headSha: string): string {
  return headSha.slice(0, 12);
}

export function reviewFindingKey(laneId: string, finding: ReviewFinding): string {
  return `${laneId}:${finding.id}`;
}

export function classifyReviewLaneState(lane: ReviewLaneRenderInput): ReviewLaneRenderState {
  if (lane.notRunReason && lane.notRunReason.trim() !== "") return "not-run";
  if (lane.origin === "trusted-provider") return "reused";
  if (lane.carriedForwardFromHeadSha && lane.carriedForwardFromHeadSha.trim() !== "") return "carried";
  if (lane.recommendation === "request-changes") return "request-changes";
  if (lane.recommendation === "approve") return "approved";
  return "inconclusive";
}

export function computeReviewRoundDelta(
  current: readonly ReviewFindingRenderRow[],
  priorRound: ReviewRoundDeltaInput,
): ReviewRoundDelta {
  const currentKeys = new Set(current.map((row) => reviewFindingKey(row.laneId, row.finding)));
  const priorKeys = new Set(priorRound.priorFindingKeys);
  let unchanged = 0;
  let added = 0;
  for (const key of currentKeys) {
    if (priorKeys.has(key)) unchanged += 1;
    else added += 1;
  }
  let fixed = 0;
  for (const key of priorKeys) {
    if (!currentKeys.has(key)) fixed += 1;
  }
  const range = priorRound.commitRange && priorRound.commitRange.trim() !== ""
    ? priorRound.commitRange
    : `${shortHead(priorRound.priorHeadSha)}..current`;
  return { fixed, unchanged, added, range, clean: currentKeys.size === 0 && added === 0 };
}

export function stripReviewMarkupComments(body: string): string {
  return body.replace(/<!--[\s\S]*?-->/g, "").trim();
}

export function visibleReviewProse(body: string): string {
  return stripReviewMarkupComments(body).replace(/\s+/g, " ").trim();
}

export function truncatedVisibleReviewProse(body: string, limit = VERDICT_TRUNCATE_CHARS): string {
  const visible = visibleReviewProse(body);
  if (visible.length <= limit) return visible;
  return visible.slice(0, limit);
}

function verdictWord(verdict: ReviewRoundVerdict): string {
  if (verdict === "request-changes") return "Request changes";
  if (verdict === "approve") return "Approve";
  if (verdict === "pending") return "Pending";
  return "Inconclusive";
}

function alertKind(verdict: ReviewRoundVerdict): "CAUTION" | "NOTE" | "WARNING" {
  if (verdict === "request-changes") return "CAUTION";
  if (verdict === "approve") return "NOTE";
  return "WARNING";
}

function countFindings(findings: readonly ReviewFindingRenderRow[]): { blocking: number; advisory: number } {
  return {
    blocking: findings.filter((row) => row.finding.severity === "blocking").length,
    advisory: findings.filter((row) => row.finding.severity === "advisory").length,
  };
}

export function renderVerdictSentence(input: {
  readonly verdict: ReviewRoundVerdict;
  readonly blocking: number;
  readonly advisory: number;
  readonly laneCount: number;
  readonly headSha: string;
  readonly roundOrdinal?: number;
}): string {
  const clean = input.verdict === "approve" && input.blocking === 0 && input.advisory === 0;
  const lead = clean ? CLEAN_ROUND_PHRASE : verdictWord(input.verdict);
  const ordinal = typeof input.roundOrdinal === "number" && input.roundOrdinal > 0 ? `, round ${input.roundOrdinal}` : "";
  const laneLabel = input.laneCount === 1 ? "1 lane" : `${input.laneCount} lanes`;
  return `${lead}: ${input.blocking} blocking, ${input.advisory} advisory, ${laneLabel}, head ${shortHead(input.headSha)}${ordinal}.`;
}

function renderVerdictBlock(
  profile: ReviewRenderCapabilityProfile,
  sentence: string,
  verdict: ReviewRoundVerdict,
  transport: ReviewPublishTransport,
  downgradeReason?: string | null,
): string {
  const degradeNote = transport === "issue-comment" || !profile.alerts
    ? ` ${DEGRADED_TRANSPORT_LABEL}; inline comments are not available.`
    : "";
  const downgrade = downgradeReason && downgradeReason.trim() !== "" ? ` Publisher downgrade: ${downgradeReason.trim()}.` : "";
  const full = `${sentence}${degradeNote}${downgrade}`;
  if (profile.alerts) {
    return [`> [!${alertKind(verdict)}]`, `> ${full}`].join("\n");
  }
  return `**${full}**`;
}

function findingClaim(profile: ReviewRenderCapabilityProfile, finding: ReviewFinding): string {
  const message = sanitize(profile, finding.message).replace(/\s+/g, " ");
  const period = message.indexOf(". ");
  const claim = period > 0 && period < 80 ? message.slice(0, period) : message;
  if (claim.length <= 80) return claim;
  return `${claim.slice(0, 77).trimEnd()}...`;
}

function fileLocationText(finding: ReviewFinding): string {
  if (!finding.location) return "no location";
  return finding.location.line ? `${finding.location.path}:${finding.location.line}` : finding.location.path;
}

function fileDeepLink(
  finding: ReviewFinding,
  headSha: string,
  repository: ReviewRepositoryRef | undefined,
): string {
  const label = fileLocationText(finding);
  if (!finding.location || !repository || headSha.trim() === "") return label;
  const line = finding.location.line ? `#L${finding.location.line}` : "";
  const path = finding.location.path.replace(/^\/+/, "");
  return `[${label}](https://github.com/${repository.owner}/${repository.name}/blob/${headSha}/${path}${line})`;
}

function threadCell(row: ReviewFindingRenderRow, transport: ReviewPublishTransport): string {
  if (transport !== "review-api") return DEGRADED_TRANSPORT_LABEL;
  if (row.anchored) return "pending";
  return row.unanchoredReason && /not part of the current diff/i.test(row.unanchoredReason)
    ? "off-diff, no thread"
    : "off-diff, no thread";
}

function renderFindingTable(
  profile: ReviewRenderCapabilityProfile,
  findings: readonly ReviewFindingRenderRow[],
  headSha: string,
  repository: ReviewRepositoryRef | undefined,
  transport: ReviewPublishTransport,
): string {
  if (findings.length === 0) return "";
  const rows = findings.map((row) => {
    const claim = findingClaim(profile, row.finding);
    return `| ${row.finding.severity} | **${claim}** | ${fileDeepLink(row.finding, headSha, repository)} | ${threadCell(row, transport)} | ${row.laneId} |`;
  });
  return [
    "| Severity | Finding | Location | Thread | Lane |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

function laneChipLabel(lane: ReviewLaneRenderInput): string {
  const state = classifyReviewLaneState(lane);
  if (state === "carried") return `carried from ${shortHead(lane.carriedForwardFromHeadSha ?? lane.evidenceHeadSha)}`;
  if (state === "not-run") return `not run (${lane.notRunReason ?? "no evidence at this head"})`;
  return state;
}

export function renderLaneChips(lanes: readonly ReviewLaneRenderInput[], expectedLanes: readonly string[]): string {
  const byLane = new Map(lanes.map((lane) => [lane.laneId, lane] as const));
  const chips = expectedLanes.map((laneId) => {
    const lane = byLane.get(laneId);
    if (!lane) return `${laneId}: not run (no evidence at this head)`;
    return `${laneId}: ${laneChipLabel(lane)}`;
  });
  return chips.join(" | ");
}

function renderDeltaLine(delta: ReviewRoundDelta): string {
  if (delta.clean) return `Clean re-review vs ${delta.range}: no remaining findings.`;
  return `Delta vs ${delta.range}: ${delta.fixed} fixed, ${delta.unchanged} unchanged, ${delta.added} new.`;
}

function wrapCollapsed(profile: ReviewRenderCapabilityProfile, title: string, content: string): string {
  if (!profile.collapsedSections) {
    return [`### ${title}`, "", content].join("\n");
  }
  return ["<details>", `<summary>${title}</summary>`, "", content, "", "</details>"].join("\n");
}

function laneNoteText(
  profile: ReviewRenderCapabilityProfile,
  lane: ReviewLaneRenderInput,
  rows: readonly ReviewFindingRenderRow[] = [],
): string {
  let summary = sanitize(profile, lane.summary);
  const findings = [
    ...lane.findings,
    ...rows.filter((row) => row.laneId === lane.laneId).map((row) => row.finding),
  ];
  const seen = new Set<string>();
  for (const finding of findings) {
    if (seen.has(finding.id)) continue;
    seen.add(finding.id);
    const message = sanitize(profile, finding.message);
    const claim = findingClaim(profile, finding);
    if (message !== "") summary = summary.split(message).join("");
    if (claim !== "" && claim !== message) summary = summary.split(claim).join("");
  }
  summary = summary.replace(/\s+/g, " ").trim();
  return summary === "" ? laneChipLabel(lane) : summary;
}

function renderCollapsedNotes(
  profile: ReviewRenderCapabilityProfile,
  input: ReviewRoundRenderInput,
): string {
  const byLane = new Map(input.lanes.map((lane) => [lane.laneId, lane] as const));
  const noteLines = input.expectedLanes.map((laneId) => {
    const lane = byLane.get(laneId);
    if (!lane) return `- ${laneId}: not run (no evidence at this head)`;
    return `- ${laneId}: ${laneNoteText(profile, lane, input.findings)}`;
  });
  const preconditions = [...new Set(input.lanes.flatMap((lane) => lane.preconditions ?? []).map((item) => item.trim()).filter((item) => item !== ""))];
  const hosts = [...new Set(input.lanes.map((lane) => lane.host).filter((item): item is string => typeof item === "string" && item.trim() !== ""))];
  const profiles = [...new Set(input.lanes.map((lane) => lane.profile).filter((item): item is string => typeof item === "string" && item.trim() !== ""))];
  const evidence = [...new Set(input.lanes.map((lane) => lane.evidencePath).filter((item): item is string => typeof item === "string" && item.trim() !== ""))];
  const provenance = [
    `- head: ${input.headSha}`,
    ...(hosts.length > 0 ? [`- hosts: ${hosts.join(", ")}`] : []),
    ...(profiles.length > 0 ? [`- profiles: ${profiles.join(", ")}`] : []),
    ...(evidence.length > 0 ? [`- evidence: ${evidence.join(", ")}`] : []),
    ...(input.rerunCommand ? [`- rerun: \`${input.rerunCommand}\``] : []),
  ];
  return [
    wrapCollapsed(profile, "Lane notes", noteLines.join("\n")),
    "",
    wrapCollapsed(profile, "Review conditions", preconditions.length === 0 ? "None recorded." : preconditions.map((item) => `- ${sanitize(profile, item)}`).join("\n")),
    "",
    wrapCollapsed(profile, "Provenance", provenance.join("\n")),
  ].join("\n");
}

export function renderRoundReviewBody(
  input: ReviewRoundRenderInput,
  profile: ReviewRenderCapabilityProfile = GITHUB_REVIEW_RENDER_PROFILE,
): ReviewRenderedBody {
  const counts = countFindings(input.findings);
  const sentence = renderVerdictSentence({
    verdict: input.verdict,
    blocking: counts.blocking,
    advisory: counts.advisory,
    laneCount: input.expectedLanes.length,
    headSha: input.headSha,
    roundOrdinal: input.roundOrdinal,
  });
  const verdict = renderVerdictBlock(profile, sentence, input.verdict, input.transport, input.publisherDowngradeReason);
  const table = renderFindingTable(profile, input.findings, input.headSha, input.repository, input.transport);
  const chips = renderLaneChips(input.lanes, input.expectedLanes);
  const delta = input.priorRound ? renderDeltaLine(computeReviewRoundDelta(input.findings, input.priorRound)) : null;
  const parts = [
    input.marker,
    "",
    verdict,
    "",
    ...(table !== "" ? [table, ""] : []),
    chips,
    "",
    ...(delta ? [delta, ""] : []),
    renderCollapsedNotes(profile, input),
  ];
  return { body: `${parts.join("\n").trimEnd()}\n`, marker: input.marker };
}

export function renderLaneReviewBody(
  input: ReviewLaneBodyRenderInput,
  profile: ReviewRenderCapabilityProfile = GITHUB_REVIEW_RENDER_PROFILE,
): ReviewRenderedBody {
  const rows: ReviewFindingRenderRow[] = input.bodyFindings.map((finding) => ({
    laneId: input.lane.laneId,
    finding,
    anchored: false,
    unanchoredReason: input.transport === "review-api" ? null : DEGRADED_TRANSPORT_LABEL,
  }));
  const countedFindings = input.lane.findings.length > 0 ? input.lane.findings : input.bodyFindings;
  const blocking = countedFindings.filter((finding) => finding.severity === "blocking").length;
  const advisory = countedFindings.filter((finding) => finding.severity === "advisory").length;
  const sentence = renderVerdictSentence({
    verdict: input.lane.recommendation,
    blocking,
    advisory,
    laneCount: 1,
    headSha: input.headSha,
  });
  const verdict = renderVerdictBlock(profile, sentence, input.lane.recommendation, input.transport);
  const table = renderFindingTable(profile, rows, input.headSha, input.repository, input.transport);
  const withheld = input.lane.withheld;
  const withheldTotal = withheld ? withheld.duplicates + withheld.offDiff + withheld.byCap : 0;
  const withheldNote = withheldTotal > 0 && withheld
    ? `Synthesis withheld ${withheldTotal} finding(s): ${withheld.duplicates} duplicate, ${withheld.offDiff} off-diff, ${withheld.byCap} beyond cap.`
    : null;
  const completeness = input.completeness && input.completeness.trim() !== ""
    ? sanitize(profile, input.completeness)
    : null;
  const parts = [
    input.marker,
    "",
    verdict,
    "",
    sanitize(profile, input.lane.summary),
    "",
    ...(table !== "" ? [table, ""] : ["No findings in this body.", ""]),
    ...(input.transport === "review-api" && input.inlineCount > 0
      ? [`${input.inlineCount} finding(s) published as inline review comments.`]
      : []),
    ...(input.transport !== "review-api" ? [`${DEGRADED_TRANSPORT_LABEL}; inline comments are not available.`] : []),
    ...(withheldNote ? [withheldNote] : []),
    ...(completeness ? ["", wrapCollapsed(profile, "Completeness", completeness)] : []),
  ];
  return { body: `${parts.join("\n").trimEnd()}\n`, marker: input.marker };
}

export interface ReviewSuggestionSafety {
  readonly safe: boolean;
  readonly reason: string | null;
}

export function suggestionFenceSafety(input: {
  readonly anchored: boolean;
  readonly finding: ReviewFinding;
}): ReviewSuggestionSafety {
  if (!input.anchored) return { safe: false, reason: "Suggestion is not line-anchored to the current diff." };
  const suggestion = input.finding.suggestion;
  if (!suggestion || suggestion.trim() === "") return { safe: false, reason: "No suggestion text was recorded." };
  const location = input.finding.location;
  if (!location || typeof location.line !== "number") return { safe: false, reason: "Suggestion has no anchored line." };
  if (location.side === "source") return { safe: false, reason: "Suggestions can only replace current-diff lines, not deleted lines." };
  const span = (location.endLine ?? location.line) - location.line;
  if (span < 0 || span > MAX_SUGGESTION_SPAN_LINES) return { safe: false, reason: `Suggestion spans more than ${MAX_SUGGESTION_SPAN_LINES} lines and is not minimal.` };
  if (suggestion.includes("```")) return { safe: false, reason: "Suggestion text contains a code fence and cannot be rendered safely." };
  if (suggestion.length > MAX_SUGGESTION_LENGTH) return { safe: false, reason: `Suggestion exceeds ${MAX_SUGGESTION_LENGTH} characters and is not minimal.` };
  return { safe: true, reason: null };
}

export function renderSuggestionFence(
  input: { readonly anchored: boolean; readonly finding: ReviewFinding },
  profile: ReviewRenderCapabilityProfile = GITHUB_REVIEW_RENDER_PROFILE,
): string | null {
  if (profile.suggestionFence === "none") return null;
  const safety = suggestionFenceSafety(input);
  if (!safety.safe) return null;
  return ["```suggestion", sanitize(profile, (input.finding.suggestion ?? "").replace(/\r\n/g, "\n")), "```"].join("\n");
}

export function renderInlineReviewComment(
  input: { readonly laneId: string; readonly finding: ReviewFinding; readonly anchored: boolean },
  profile: ReviewRenderCapabilityProfile = GITHUB_REVIEW_RENDER_PROFILE,
): string {
  const claim = findingClaim(profile, input.finding);
  const fence = renderSuggestionFence(input, profile);
  const lines = [
    `**${claim}**`,
    `${input.finding.severity} | ${input.laneId}`,
  ];
  if (fence) lines.push("", fence);
  return lines.join("\n");
}

export function reviewFindingDigest(rows: readonly ReviewFindingRenderRow[], extra: unknown = null): string {
  return createHash("sha256")
    .update(JSON.stringify({
      findings: rows.map((row) => ({
        lane: row.laneId,
        id: row.finding.id,
        severity: row.finding.severity,
        location: row.finding.location ?? null,
        message: row.finding.message,
        suggestion: row.finding.suggestion ?? null,
        confidence: typeof row.finding.confidence === "number" ? row.finding.confidence : null,
        anchored: row.anchored,
      })),
      extra,
    }))
    .digest("hex")
    .slice(0, 16);
}

export function isSelfAuthoredReviewBody(text: string | undefined): boolean {
  const body = text ?? "";
  return body.includes("<!-- qube-pr-review:") || body.includes("<!-- qube-pr-review-summary:") || body.includes("<!-- qube-pr-status:");
}
