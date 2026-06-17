const { greet, calculateSum } = require("./index.js");

describe("greet", () => {
	test("should return greeting with name", () => {
		expect(greet("Alice")).toBe("Hello, Alice!");
		expect(greet("Bob")).toBe("Hello, Bob!");
	});
});

describe("calculateSum", () => {
	test("should calculate sum of numbers", () => {
		expect(calculateSum([1, 2, 3])).toBe(6);
		expect(calculateSum([])).toBe(0);
		expect(calculateSum([10])).toBe(10);
	});
});
