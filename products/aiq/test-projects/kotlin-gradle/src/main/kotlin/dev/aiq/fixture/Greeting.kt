package dev.aiq.fixture

object Greeting {
    fun message(name: String): String {
        val trimmedName = name.trim()
        return "Hello, $trimmedName!"
    }
}
