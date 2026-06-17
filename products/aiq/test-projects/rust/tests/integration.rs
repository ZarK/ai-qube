use aiq_rust_fixture::{greet, sum};

#[test]
fn greets_from_integration_tests() {
    assert_eq!(greet("Rust"), "Hello, Rust!");
}

#[test]
fn sums_from_integration_tests() {
    assert_eq!(sum(&[4, 5]), 9);
}
