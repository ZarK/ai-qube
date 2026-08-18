# QUBE Cursor adapter

This package routes QUBE isolated review lanes through the official Cursor CLI. It uses the CLI's existing browser login or `CURSOR_API_KEY` authentication and does not read or transfer credentials.

Each lane starts a fresh Cursor Ask-mode process and accepts one successful JSON result. QUBE owns evidence validation, checkout protection, and provider publication. macOS and Linux runs also enable the Cursor sandbox. Native Windows uses Cursor's enforced read-only Ask mode because the current Cursor sandbox is not available on Windows.
