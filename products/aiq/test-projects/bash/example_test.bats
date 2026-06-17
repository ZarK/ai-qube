#!/usr/bin/env bats

setup() {
    source "$(dirname "$BATS_TEST_FILENAME")/example.sh"
}

@test "greet outputs hello message" {
    result=$(greet "Alice")
    [ "$result" = "Hello, Alice!" ]
}

@test "greet uses default name" {
    result=$(greet)
    [ "$result" = "Hello, World!" ]
}

@test "calculate_sum adds numbers correctly" {
    result=$(calculate_sum 1 2 3)
    [ "$result" = "6" ]
}

@test "calculate_sum handles single number" {
    result=$(calculate_sum 5)
    [ "$result" = "5" ]
}

@test "calculate_sum handles zero" {
    result=$(calculate_sum 0 0 0)
    [ "$result" = "0" ]
}
