package fixture

import "testing"

func TestGreet(t *testing.T) {
	t.Helper()

	got := Greet("  AIQ  ")
	if got != "Hello, AIQ!" {
		t.Fatalf("expected trimmed greeting, got %q", got)
	}
}

func TestSum(t *testing.T) {
	t.Helper()

	got := Sum([]int{1, 2, 3})
	if got != 6 {
		t.Fatalf("expected sum 6, got %d", got)
	}
}
