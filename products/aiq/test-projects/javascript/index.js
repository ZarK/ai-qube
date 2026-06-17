/**
 * Simple JavaScript example for testing quality pipeline.
 */

/**
 * Return a greeting message.
 * @param {string} name - The name to greet
 * @returns {string} The greeting message
 */
function greet(name) {
	return `Hello, ${name}!`;
}

/**
 * Calculate the sum of an array of numbers.
 * @param {number[]} numbers - Array of numbers to sum
 * @returns {number} The sum of the numbers
 */
function calculateSum(numbers) {
	let total = 0;
	for (const num of numbers) {
		total += num;
	}
	return total;
}

module.exports = {
	greet,
	calculateSum,
};
