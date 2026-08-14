# Layout Fixtures

Fixture repositories under this directory model repository shapes for `aie repo inspect` and `aie repo affected`.

Each fixture should be small, deterministic, and free of generated build output. Tests copy or initialize these directories in temporary git repositories before running layout detection, so fixture contents should describe repository structure rather than depend on the active checkout.

Add one positive fixture and one negative or ambiguous fixture for each layout shape issue. Changed-path examples belong in tests so expected affected projects and gates stay executable.

Current fixture shapes:

- `js-workspace`: positive JavaScript workspace fixture with a root package, workspace manifest, app and package projects, Turbo metadata, lockfile, and GitHub Actions workflow.
- `ambiguous-js-workspace`: negative JavaScript workspace fixture with tooling metadata but no root package manifest.
- `python-workspace`: positive Python workspace fixture with a root `pyproject.toml`, uv workspace members, package and service projects, Python workflow metadata, and `uv.lock`.
- `ambiguous-python-workspace`: negative Python workspace fixture with Python workspace tooling metadata and a nested package but no root `pyproject.toml`.
- `rust-workspace`: positive Rust workspace fixture with a root `Cargo.toml` workspace members list, `Cargo.lock`, crate projects, and a GitHub Actions workflow.
- `ambiguous-rust-workspace`: negative Rust workspace fixture with `Cargo.lock` and a nested crate but no root `Cargo.toml`.
- `go-workspace`: positive Go module workspace fixture with a root `go.work`, member `go.mod` files, and a GitHub Actions workflow.
- `ambiguous-go-workspace`: negative Go workspace fixture with a nested module but no root `go.work`.
- `java-kotlin-gradle`: positive Java/Kotlin multi-project fixture with root `settings.gradle.kts`, root `build.gradle.kts`, included modules, and a GitHub Actions workflow.
- `java-kotlin-maven`: positive Java/Kotlin multi-project fixture with a root aggregator `pom.xml`, member modules, and a GitHub Actions workflow.
- `ambiguous-java-kotlin`: negative Java/Kotlin fixture with a nested Gradle module but no root settings file or aggregator `pom.xml`.
- `dotnet-solution`: positive .NET solution fixture with a root `.sln`, `Directory.Build.props`, two projects, and a GitHub Actions workflow.
- `ambiguous-dotnet-solution`: negative .NET fixture with a nested `.csproj` but no root solution file.
- `bazel-monorepo`: positive Bazel monorepo fixture with root `MODULE.bazel`, `WORKSPACE`, two `BUILD` packages, and a GitHub Actions workflow.
- `pants-monorepo`: positive Pants monorepo fixture with root `pants.toml` source roots, two `BUILD` packages, and a GitHub Actions workflow.
- `ambiguous-bazel-pants-buck`: negative Bazel/Pants/Buck fixture with a nested `BUILD` package but no root workspace proof file.
- `cmake-superbuild`: positive CMake superbuild fixture with root `CMakeLists.txt` `add_subdirectory` members, `CMakePresets.json`, two projects, and a GitHub Actions workflow.
- `ambiguous-cmake-superbuild`: negative CMake fixture with a nested `CMakeLists.txt` but no root `add_subdirectory` or FetchContent proof.
- `single-app-service`: positive single app service fixture with exactly one root package/build signal.
- `ambiguous-single-app`: negative fixture with conflicting root package/build signals that must not be classified as a single app service.
