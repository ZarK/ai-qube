export type LizardLikeFileMetrics = {
  blockCount: number;
  maintainability: {
    rank: string;
    score: number;
  };
  maxComplexity: {
    rank: string;
    score: number;
  };
  raw: {
    sloc: number;
  };
};

export type PythonLikeFileMetrics = {
  cc: Array<{
    complexity: number;
    rank: string;
  }>;
  mi: {
    rank: string;
    score: number;
  };
  raw: {
    sloc: number;
  };
};

export type SharedMetricTotals = {
  maxComplexity: number;
  maxRank: string;
  minMaintainability: number;
  minMaintainabilityRank: string;
  scannedFileCount: number;
  totalBlocks: number;
  totalDurationMs: number;
  totalSloc: number;
};

export function createSharedMetricTotals(): SharedMetricTotals {
  return {
    maxComplexity: 0,
    maxRank: "A",
    minMaintainability: Number.POSITIVE_INFINITY,
    minMaintainabilityRank: "A",
    scannedFileCount: 0,
    totalBlocks: 0,
    totalDurationMs: 0,
    totalSloc: 0,
  };
}

export function addCachedMetricDuration(
  totals: SharedMetricTotals,
  cachedMetrics: { cacheHit: boolean; metrics: { durationMs: number } },
): void {
  totals.totalDurationMs += cachedMetrics.cacheHit ? 0 : cachedMetrics.metrics.durationMs;
}

export function addLizardFileMetrics(
  totals: SharedMetricTotals,
  files: Record<string, LizardLikeFileMetrics>,
): void {
  totals.scannedFileCount += Object.keys(files).length;
  for (const fileMetrics of Object.values(files)) {
    addLizardMetricFile(totals, fileMetrics);
  }
}

export function addPythonFileMetrics(
  totals: SharedMetricTotals,
  files: Record<string, PythonLikeFileMetrics>,
): void {
  totals.scannedFileCount += Object.keys(files).length;
  for (const fileMetrics of Object.values(files)) {
    addPythonMetricFile(totals, fileMetrics);
  }
}

function addLizardMetricFile(
  totals: SharedMetricTotals,
  fileMetrics: LizardLikeFileMetrics,
): void {
  totals.totalSloc += fileMetrics.raw.sloc;
  totals.totalBlocks += fileMetrics.blockCount;
  if (fileMetrics.maxComplexity.score > totals.maxComplexity) {
    totals.maxComplexity = fileMetrics.maxComplexity.score;
    totals.maxRank = fileMetrics.maxComplexity.rank;
  }
  if (fileMetrics.maintainability.score < totals.minMaintainability) {
    totals.minMaintainability = fileMetrics.maintainability.score;
    totals.minMaintainabilityRank = fileMetrics.maintainability.rank;
  }
}

function addPythonMetricFile(
  totals: SharedMetricTotals,
  fileMetrics: PythonLikeFileMetrics,
): void {
  totals.totalSloc += fileMetrics.raw.sloc;
  totals.totalBlocks += fileMetrics.cc.length;
  for (const block of fileMetrics.cc) {
    if (block.complexity > totals.maxComplexity) {
      totals.maxComplexity = block.complexity;
      totals.maxRank = block.rank;
    }
  }

  if (fileMetrics.mi.score < totals.minMaintainability) {
    totals.minMaintainability = fileMetrics.mi.score;
    totals.minMaintainabilityRank = fileMetrics.mi.rank;
  }
}
