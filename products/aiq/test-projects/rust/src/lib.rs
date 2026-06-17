pub fn greet(name: &str) -> String {
    let trimmed_name = name.trim();
    format!("Hello, {trimmed_name}!")
}

pub fn sum(values: &[i32]) -> i32 {
    values.iter().sum()
}

#[cfg(test)]
mod tests {
    use super::{greet, sum};

    #[test]
    fn trims_the_greeting_name() {
        assert_eq!(greet("  AIQ  "), "Hello, AIQ!");
    }

    #[test]
    fn sums_values() {
        assert_eq!(sum(&[1, 2, 3]), 6);
    }
}
