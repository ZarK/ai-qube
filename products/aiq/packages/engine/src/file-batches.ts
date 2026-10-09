/** Reserve space for the executable, options, and shell quoting on every platform. */
export const fileArgumentBudget = 6_000;

export function batchFileArguments(
  files: readonly string[],
  budget = fileArgumentBudget,
): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  let length = 0;
  for (const file of files) {
    const argumentLength = file.length * 2 + 4;
    if (argumentLength > budget) {
      throw new Error(`File argument exceeds the command-line budget: ${file}`);
    }
    if (length + argumentLength > budget) {
      batches.push(batch);
      batch = [];
      length = 0;
    }
    batch.push(file);
    length += argumentLength;
  }
  if (batch.length > 0) {
    batches.push(batch);
  }
  return batches;
}

export async function runFileBatches<T>(
  files: readonly string[],
  runBatch: (batch: string[]) => Promise<T>,
): Promise<T[]> {
  const results: T[] = [];
  for (const batch of batchFileArguments(files)) {
    results.push(await runBatch(batch));
  }
  return results;
}
