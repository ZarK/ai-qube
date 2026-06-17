/**
 * Simple TypeScript example for testing quality pipeline.
 */

/**
 * Return a greeting message.
 * @param name - The name to greet
 * @returns The greeting message
 */
export function greet(name: string): string {
  return `Hello, ${name}!`;
}

/**
 * Calculate the sum of an array of numbers.
 * @param numbers - Array of numbers to sum
 * @returns The sum of the numbers
 */
export function calculateSum(numbers: number[]): number {
  let total = 0;
  for (const num of numbers) {
    total += num;
  }
  return total;
}
