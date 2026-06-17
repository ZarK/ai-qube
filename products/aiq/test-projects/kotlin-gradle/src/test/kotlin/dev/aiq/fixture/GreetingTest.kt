package dev.aiq.fixture

import kotlin.test.Test
import kotlin.test.assertEquals

class GreetingTest {
    @Test
    fun trimsInput() {
        assertEquals("Hello, AIQ!", Greeting.message("  AIQ  "))
    }
}
