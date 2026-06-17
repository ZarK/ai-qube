#!/usr/bin/env python3
"""
Simple Python example for testing quality pipeline.
"""


def greet(name: str) -> str:
    """Return a greeting message."""
    return f"Hello, {name}!"


def calculate_sum(numbers: list[int]) -> int:
    """Calculate the sum of a list of numbers."""
    total = 0
    for num in numbers:
        total += num
    return total


if __name__ == "__main__":
    print(greet("World"))
    result = calculate_sum([1, 2, 3, 4, 5])
    print(f"Sum: {result}")
