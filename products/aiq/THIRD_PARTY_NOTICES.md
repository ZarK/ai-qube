Third-Party Notices

This project invokes several third-party tools at runtime. We do not redistribute their code or binaries; they are executed from the user's environment (or via package managers like uvx/bunx/npx/dotnet/maven/gradle). Please consult each project's license before use.

Notable tools invoked by the quality pipeline
- Lizard (code complexity): https://github.com/terryyin/lizard
  - Invoked via uvx lizard
- Radon (Python metrics): https://github.com/radon-h2020/radon
  - Invoked via local environment (pip/uv)
- Ruff (Python lint/format): https://github.com/astral-sh/ruff
- mypy (Python types): https://github.com/python/mypy
- pytest / pytest-cov (Python tests/coverage): https://github.com/pytest-dev/pytest
- Biome (JS/TS): https://github.com/biomejs/biome
- TypeScript (tsc): https://github.com/microsoft/TypeScript
- Vitest (tests): https://github.com/vitest-dev/vitest
- shellcheck/shfmt (Shell): https://www.shellcheck.net/ / https://github.com/mvdan/sh
- htmlhint/stylelint (HTML/CSS): https://github.com/htmlhint/HTMLHint / https://github.com/stylelint/stylelint
- dotnet CLI (C#): https://github.com/dotnet/sdk
- Maven/Gradle (Java): https://maven.apache.org/ / https://gradle.org/
- gitleaks (secrets): https://github.com/gitleaks/gitleaks
- semgrep (SAST): https://github.com/returntocorp/semgrep
- tfsec (Terraform security): https://github.com/aquasecurity/tfsec

If you distribute a bundle that includes any of the above, you must comply with their licenses. This repository and the @tjalve/aiq package are licensed under MIT (see LICENSE).
