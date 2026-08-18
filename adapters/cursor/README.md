# QUBE Cursor adapter

This package routes QUBE isolated review lanes through the official Cursor CLI. It uses the CLI's existing browser login or `CURSOR_API_KEY` authentication and does not read or transfer credentials.

Each lane starts a fresh Cursor Ask-mode process with the Cursor sandbox enabled and accepts one successful JSON result. QUBE owns evidence validation, checkout protection, and provider publication. Cursor does not currently provide its sandbox on native Windows, so QUBE fails closed there instead of weakening review isolation. Use WSL2, Linux, or macOS for Cursor review lanes. QUBE can still diagnose an official native Windows Cursor installation and its PowerShell shim.
