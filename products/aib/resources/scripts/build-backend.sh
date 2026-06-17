#!/bin/bash
set -e

# Build the .NET backend as a self-contained executable for the current platform

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_PROJECT="$PROJECT_ROOT/src/Memex.Backend/Memex.Backend.csproj"

# Detect platform
if [[ "$OSTYPE" == "darwin"* ]]; then
    if [[ $(uname -m) == "arm64" ]]; then
        RID="osx-arm64"
        TARGET="aarch64-apple-darwin"
    else
        RID="osx-x64"
        TARGET="x86_64-apple-darwin"
    fi
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    if [[ $(uname -m) == "x86_64" ]]; then
        RID="linux-x64"
        TARGET="x86_64-unknown-linux-gnu"
    elif [[ $(uname -m) == "aarch64" ]]; then
        RID="linux-arm64"
        TARGET="aarch64-unknown-linux-gnu"
    fi
elif [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "win32" ]]; then
    RID="win-x64"
    TARGET="x86_64-pc-windows-msvc"
fi

OUTPUT_DIR="$PROJECT_ROOT/apps/memex-electron/resources/backend/memex-backend-$TARGET"

echo "Building Memex.Backend for $RID ($TARGET)..."
echo "Output directory: $OUTPUT_DIR"

mkdir -p "$OUTPUT_DIR"

dotnet publish "$BACKEND_PROJECT" \
    -c Release \
    -r "$RID" \
    --self-contained true \
    -p:PublishSingleFile=true \
    -p:IncludeNativeLibrariesForSelfExtract=true \
    -p:EnableCompressionInSingleFile=true \
    -o "$OUTPUT_DIR"

# Rename to memex-backend for Electron sidecar
if [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "win32" ]]; then
    mv "$OUTPUT_DIR/Memex.Backend.exe" "$OUTPUT_DIR/memex-backend.exe" 2>/dev/null || true
else
    mv "$OUTPUT_DIR/Memex.Backend" "$OUTPUT_DIR/memex-backend" 2>/dev/null || true
    chmod +x "$OUTPUT_DIR/memex-backend"
fi

echo "Backend built successfully!"
echo "Executable: $OUTPUT_DIR/memex-backend"
