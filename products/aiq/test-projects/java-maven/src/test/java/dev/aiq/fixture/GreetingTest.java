package dev.aiq.fixture;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

final class GreetingTest {
  @Test
  void trimsInput() {
    assertEquals("Hello, AIQ!", Greeting.message("  AIQ  "));
  }
}
