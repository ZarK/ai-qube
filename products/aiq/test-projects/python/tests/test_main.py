from pathlib import Path
import subprocess
import sys

from main import calculate_sum, greet


FIXTURE_ROOT = Path(__file__).resolve().parents[1]


def test_greet() -> None:
    assert greet("Alice") == "Hello, Alice!"
    assert greet("Bob") == "Hello, Bob!"


def test_calculate_sum() -> None:
    assert calculate_sum([1, 2, 3]) == 6
    assert calculate_sum([]) == 0
    assert calculate_sum([10]) == 10


def test_main_execution() -> None:
    result = subprocess.run(
        [sys.executable, "main.py"],
        capture_output=True,
        cwd=FIXTURE_ROOT,
        text=True,
    )
    assert result.returncode == 0
    assert "Hello, World!" in result.stdout
    assert "Sum: 15" in result.stdout
