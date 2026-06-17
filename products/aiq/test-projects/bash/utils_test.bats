#!/usr/bin/env bats

setup() {
    source "$(dirname "$BATS_TEST_FILENAME")/utils.sh"
}

@test "is_empty returns true for empty string" {
    run is_empty ""
    [ "$status" -eq 0 ]
}

@test "is_empty returns false for non-empty string" {
    run is_empty "hello"
    [ "$status" -eq 1 ]
}

@test "to_upper converts to uppercase" {
    result=$(to_upper "hello")
    [ "$result" = "HELLO" ]
}

@test "to_lower converts to lowercase" {
    result=$(to_lower "HELLO")
    [ "$result" = "hello" ]
}

@test "is_even returns true for even numbers" {
    run is_even 4
    [ "$status" -eq 0 ]
}

@test "is_even returns false for odd numbers" {
    run is_even 3
    [ "$status" -eq 1 ]
}

@test "is_odd returns true for odd numbers" {
    run is_odd 3
    [ "$status" -eq 0 ]
}

@test "is_odd returns false for even numbers" {
    run is_odd 4
    [ "$status" -eq 1 ]
}

@test "reverse_string reverses a string" {
    result=$(reverse_string "hello")
    [ "$result" = "olleh" ]
}

@test "count_words counts words correctly" {
    result=$(count_words "one two three")
    [ "$result" = "3" ]
}
