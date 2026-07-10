import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { RiskCard, RiskCardCatalogValidation } from "./types.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const catalogPath = join(packageRoot, "assets", "risk-cards", "catalog.json");

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
    for (const card of cards) {
      if (card.pathGlobs.length === 0 && card.issueKeywords.length === 0) {
        errors.push(`Card ${card.id} has no pathGlobs or issueKeywords triggers.`);
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
