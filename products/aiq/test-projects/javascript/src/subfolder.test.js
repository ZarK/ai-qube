const { greet, multiply } = require("./subfolder.js");

describe("subfolder greet", () => {
  test("returns a greeting from the nested fixture", () => {
    expect(greet("Alice")).toBe("Hello from src, Alice!");
  });
});

describe("subfolder multiply", () => {
  test("multiplies two values", () => {
    expect(multiply(3, 4)).toBe(12);
  });
});
