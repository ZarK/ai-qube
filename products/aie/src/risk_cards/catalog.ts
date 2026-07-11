import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { RiskCard, RiskCardCatalogValidation } from "./types.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const catalogPath = join(packageRoot, "assets", "risk-cards", "catalog.json");

export const REQUIRED_RISK_CARD_IDS = [
  "truthful-state-transitions",
  "mode-provider-matrix",
  "trust-identity-boundaries",
  "freshness-cache-identity",
  "bounds-cancellation",
  "multi-process-concurrency",
  "filesystem-boundaries",
  "serialization-encoding",
  "workspace-shipped-parity",
  "oracle-quality",
] as const;

const KEBAB_CASE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** Imperative obligation to ship concrete test/fixture/assert coverage. */
const TEST_OBLIGATION = /\b(?:write|add|ship|cover|include|create|require|demand)\b[\s\S]{0,80}\b(?:negative\s+)?(?:test|tests|fixture|fixtures|assert|asserts|oracle|counterexample)s?\b|\b(?:negative\s+test|positive\s+(?:case|observation)|oracle\s+fixture|malformed[- ]payload\s+fixture|stale-head\s+fixture|concurrent-write\s+fixture)\b/i;
const TEST_PROHIBITION = /\b(?:do\s+not|don't|not\s+required|no\s+need\s+to)\b[^.!?]{0,60}\b(?:test|tests|fixture|fixtures|assert|oracle)\b|\btests?\s+are\s+not\s+required\b/i;

let cachedCards: readonly RiskCard[] | null = null;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string" && item.trim().length > 0);
}

function isRiskCard(value: unknown): value is RiskCard {
  if (!value || typeof value !== "object") return false;
  const card = value as Record<string, unknown>;
  return typeof card.id === "string" && card.id.trim().length > 0
    && typeof card.title === "string" && card.title.trim().length > 0
    && typeof card.rank === "number" && Number.isFinite(card.rank)
    && isStringArray(card.pathGlobs)
    && isStringArray(card.issueKeywords)
    && typeof card.implementerFace === "string" && card.implementerFace.trim().length > 0
    && typeof card.reviewerFace === "string" && card.reviewerFace.trim().length > 0;
}

function sentenceCount(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/(?<=[.!?])\s+/).filter(part => part.trim().length > 0).length;
}

export function implementerFaceHasTestObligation(text: string): boolean {
  const normalized = text.trim();
  if (normalized.length === 0) return false;
  // Prohibitions win: "do not add a fixture" must never count as an obligation.
  if (TEST_PROHIBITION.test(normalized)) return false;
  return TEST_OBLIGATION.test(normalized);
}

export function loadRiskCardCatalog(): readonly RiskCard[] {
  if (cachedCards) return cachedCards;
  const raw = JSON.parse(readFileSync(catalogPath, "utf8")) as unknown;
  if (!Array.isArray(raw) || !raw.every(isRiskCard)) {
    throw new Error(`Invalid risk card catalog at ${catalogPath}.`);
  }
  const seen = new Set<string>();
  for (const card of raw) {
    if (seen.has(card.id)) throw new Error(`Duplicate risk card id ${card.id}.`);
    seen.add(card.id);
  }
  cachedCards = Object.freeze(raw.map(card => Object.freeze({ ...card, pathGlobs: Object.freeze([...card.pathGlobs]), issueKeywords: Object.freeze([...card.issueKeywords]) })));
  return cachedCards;
}

export function validateRiskCardCatalog(): RiskCardCatalogValidation {
  try {
    const cards = loadRiskCardCatalog();
    const errors: string[] = [];
    if (cards.length < 10) errors.push(`Expected at least 10 risk cards, found ${cards.length}.`);

    const byId = new Map(cards.map(card => [card.id, card]));
    for (const requiredId of REQUIRED_RISK_CARD_IDS) {
      if (!byId.has(requiredId)) errors.push(`Missing required risk card id ${requiredId}.`);
    }

    for (const card of cards) {
      if (!KEBAB_CASE_ID.test(card.id)) {
        errors.push(`Card id ${card.id} must be kebab-case.`);
      }
      if (!Number.isInteger(card.rank) || card.rank < 0) {
        errors.push(`Card ${card.id} rank must be a non-negative integer.`);
      }
      if (card.pathGlobs.length === 0 && card.issueKeywords.length === 0) {
        errors.push(`Card ${card.id} has no pathGlobs or issueKeywords triggers.`);
      }
      const implementerSentences = sentenceCount(card.implementerFace);
      const reviewerSentences = sentenceCount(card.reviewerFace);
      if (implementerSentences < 2 || implementerSentences > 4) {
        errors.push(`Card ${card.id} implementer face must be 2-4 sentences (found ${implementerSentences}).`);
      }
      if (reviewerSentences < 2 || reviewerSentences > 4) {
        errors.push(`Card ${card.id} reviewer face must be 2-4 sentences (found ${reviewerSentences}).`);
      }
      if (!implementerFaceHasTestObligation(card.implementerFace)) {
        errors.push(`Card ${card.id} implementer face must name a concrete test obligation.`);
      }
    }

    return { ok: errors.length === 0, errors, cardCount: cards.length };
  } catch (error) {
    return {
      ok: false,
      errors: [error instanceof Error ? error.message : String(error)],
      cardCount: 0,
    };
  }
}

export function riskCardFaceSha256(text: string): string {
  return createHash("sha256").update(text.trimEnd(), "utf8").digest("hex");
}

export function formatRiskCardReviewerFragment(card: RiskCard): string {
  return [
    `Risk card ${card.id}: ${card.title}`,
    card.reviewerFace.trim(),
  ].join("\n");
}

export function formatRiskCardImplementerFragment(card: RiskCard): string {
  return [
    `Risk card ${card.id}: ${card.title}`,
    card.implementerFace.trim(),
  ].join("\n");
}

export function riskCardCatalogPath(): string {
  return catalogPath;
}
