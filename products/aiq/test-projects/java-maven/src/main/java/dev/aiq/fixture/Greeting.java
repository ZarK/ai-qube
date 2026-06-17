package dev.aiq.fixture;

public final class Greeting {
  private Greeting() {}

  public static String message(String name) {
    String trimmedName = name.trim();
    return "Hello, " + trimmedName + "!";
  }
}
