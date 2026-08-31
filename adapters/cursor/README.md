# QUBE Cursor adapter

This package routes QUBE isolated review lanes through the official Cursor CLI. It uses the CLI's existing browser login or `CURSOR_API_KEY` authentication and does not read or transfer credentials.

Each lane starts a fresh Cursor Ask-mode process and accepts one successful JSON result. QUBE owns evidence validation, checkout protection, and provider publication. Linux and macOS use the Cursor sandbox. Native Windows uses QUBE's permission-denying ACP client because the Cursor sandbox is not available there. The ACP client isolates Cursor configuration, disables sandbox network access, permits bounded repository reads except protected metadata and common secret files, cancels every permission request, and exposes no terminal, write, MCP, or web capability. Native Windows does not require WSL2.

On native Windows, QUBE inspects the ACP model options without sending a review prompt. It compares the selected Cursor model ID with the ACP base model, reasoning effort, and speed. Setup and diagnostics list only exact compatible choices. A missing, ambiguous, or different match blocks the route with `model-route-model-unsupported`.

The readiness probe records both the selected Cursor model ID and the exact ACP value. The review runner uses that recorded value. If the ACP catalog changes before execution, QUBE stops before it sends the review prompt. When a configured fallback host runs, provider-visible provenance keeps the original compatibility reason.
