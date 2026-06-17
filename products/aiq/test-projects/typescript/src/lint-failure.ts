export function calculateSumWithLintFailure(numbers: number[]): number {
  var total = 0;
  for (const number of numbers) {
    total += number;
  }
  return total;
}
