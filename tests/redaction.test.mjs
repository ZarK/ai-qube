import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("redaction helpers", () => {
  it("redacts common token-like values in strings", async () => {
    const { redactText } = await import("../dist/index.js");
    const githubToken = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
    const bearerToken = "Bearer abcdefghijklmnopqrstuvwxyz123456";
    const assignment = "api_key=abcdefghijklmnopqrstuvwxyz123456";

    assert.equal(redactText(`token ${githubToken}`), "token [REDACTED]");
    assert.equal(redactText(`auth ${bearerToken}`), "auth Bearer [REDACTED]");
    assert.equal(redactText(`bad ${assignment}`), "bad api_key=[REDACTED]");
  });

  it("redacts structured diagnostics while preserving shape", async () => {
    const { redactStructuredValue } = await import("../dist/index.js");
    const diagnostic = {
      ok: false,
      details: {
        accessToken: "abcdefghijklmnopqrstuvwxyz123456",
        password: 123456789,
        nested: ["Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456", { safe: "alpha" }]
      }
    };

    assert.deepEqual(redactStructuredValue(diagnostic), {
      ok: false,
      details: {
        accessToken: "[REDACTED]",
        password: "[REDACTED]",
        nested: ["Authorization: Bearer [REDACTED]", { safe: "alpha" }]
      }
    });
  });
});
