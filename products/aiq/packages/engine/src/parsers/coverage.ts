import { readIntegerString, readNestedValue } from "./utils.js";
import { parseXmlAttributes } from "./xml.js";

export function readCoberturaLineRate(reportContents: string | undefined): number | undefined {
  if (reportContents === undefined) {
    return undefined;
  }

  const match = /<coverage[^>]*line-rate="([0-9.]+)"/u.exec(reportContents);
  if (match?.[1] === undefined) {
    return undefined;
  }

  const rate = Number.parseFloat(match[1]);
  if (!Number.isFinite(rate)) {
    return undefined;
  }

  return rate <= 1 ? rate * 100 : rate;
}

export function readJacocoLineRate(reportContents: string | undefined): number | undefined {
  if (reportContents === undefined) {
    return undefined;
  }

  const lineMatches = [...reportContents.matchAll(/<counter\b([^>]*)\/?>/gu)]
    .map((match) => parseXmlAttributes(match[1] ?? ""))
    .filter((attributes) => (attributes.type ?? "").toUpperCase() === "LINE");
  const rootCounter = lineMatches.at(-1);
  if (rootCounter === undefined) {
    return undefined;
  }

  const covered = readIntegerString(rootCounter.covered) ?? 0;
  const missed = readIntegerString(rootCounter.missed) ?? 0;
  const total = missed + covered;
  if (total === 0) {
    return undefined;
  }

  return (covered / total) * 100;
}

export function readLcovLineRate(reportContents: string | undefined): number | undefined {
  if (reportContents === undefined) {
    return undefined;
  }

  let foundData = false;
  let linesFound = 0;
  let linesHit = 0;
  for (const line of reportContents.split(/\r?\n/u)) {
    const counts = readLcovLineCounts(line);
    linesFound += counts.linesFound;
    linesHit += counts.linesHit;
    foundData ||= counts.foundData;
  }

  if (!foundData || linesFound === 0) {
    return undefined;
  }

  return (linesHit / linesFound) * 100;
}

function readLcovLineCounts(line: string): {
  foundData: boolean;
  linesFound: number;
  linesHit: number;
} {
  if (line.startsWith("LF:")) {
    return { foundData: true, linesFound: readIntegerString(line.slice(3)) ?? 0, linesHit: 0 };
  }
  if (line.startsWith("LH:")) {
    return { foundData: true, linesFound: 0, linesHit: readIntegerString(line.slice(3)) ?? 0 };
  }
  return { foundData: false, linesFound: 0, linesHit: 0 };
}

export function readCoverageMetric(
  summary: Record<string, unknown> | undefined,
  ...keys: string[]
): number | undefined {
  if (summary === undefined) {
    return undefined;
  }

  const value = readNestedValue(summary, keys);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
