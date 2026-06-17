package fixture

import "testing"

func TestNestedGreeting(t *testing.T) {
	t.Helper()

	if got := NestedGreeting("AIQ"); got != "Hello from pkg, AIQ!" {
		t.Fatalf("expected nested greeting, got %q", got)
	}
}

func TestMultiply(t *testing.T) {
	t.Helper()

	if got := Multiply(3, 4); got != 12 {
		t.Fatalf("expected product 12, got %d", got)
	}
}
