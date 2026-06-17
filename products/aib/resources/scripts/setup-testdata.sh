#!/bin/bash
#
# Memex Test Data Setup Script
#
# Downloads real photos from open datasets for comprehensive testing.
# This is a wrapper that calls the Python setup script.
#
# Usage:
#   ./scripts/setup-testdata.sh           # Full setup (all datasets)
#   ./scripts/setup-testdata.sh quick     # Quick setup (EXIF samples only)
#   ./scripts/setup-testdata.sh --help    # Show help
#
# Requirements:
#   - Python 3.10+
#   - pip install requests tqdm fiftyone (optional for ML datasets)
#   - exiftool (brew install exiftool)
#   - czkawka_cli (brew install czkawka)
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

print_header() {
	echo ""
	echo "============================================================"
	echo "  $1"
	echo "============================================================"
	echo ""
}

print_step() {
	echo -e "  ${GREEN}→${NC} $1"
}

print_warning() {
	echo -e "  ${YELLOW}⚠${NC} $1"
}

print_error() {
	echo -e "  ${RED}✗${NC} $1"
}

check_dependencies() {
	print_header "Checking Dependencies"

	local missing=0

	# Check Python
	if command -v python3 &>/dev/null; then
		print_step "Python 3: $(python3 --version)"
	else
		print_error "Python 3 not found"
		missing=1
	fi

	# Check requests
	if python3 -c "import requests" 2>/dev/null; then
		print_step "requests: installed"
	else
		print_warning "requests not installed (pip install requests)"
	fi

	# Check fiftyone (optional)
	if python3 -c "import fiftyone" 2>/dev/null; then
		print_step "fiftyone: installed"
	else
		print_warning "fiftyone not installed (optional, for COCO/LFW datasets)"
	fi

	# Check exiftool
	if command -v exiftool &>/dev/null; then
		print_step "exiftool: $(exiftool -ver)"
	else
		print_error "exiftool not found (brew install exiftool)"
		missing=1
	fi

	# Check czkawka
	if command -v czkawka_cli &>/dev/null; then
		print_step "czkawka_cli: $(czkawka_cli --version 2>&1 | head -1)"
	else
		print_warning "czkawka_cli not found (brew install czkawka)"
	fi

	if [ $missing -eq 1 ]; then
		echo ""
		print_error "Missing required dependencies. Please install them first."
		exit 1
	fi
}

show_help() {
	cat <<EOF
Memex Test Data Setup Script

Usage:
    ./scripts/setup-testdata.sh [command] [options]

Commands:
    (none)      Full setup with all available datasets
    quick       Quick setup with only EXIF samples (~100 photos)
    clean       Remove all test data
    verify      Verify existing test data (check EXIF stats)

Options:
    --help      Show this help message
    --no-coco   Skip COCO dataset (faster, smaller)
    --no-lfw    Skip LFW face dataset

Examples:
    ./scripts/setup-testdata.sh                 # Full setup (~800+ photos)
    ./scripts/setup-testdata.sh quick           # Quick setup (~100 photos)
    ./scripts/setup-testdata.sh --no-coco       # Skip COCO download

Datasets downloaded:
    - ianare/exif-samples: ~90 photos with real EXIF data (GPS, dates, cameras)
    - drewnoakes/metadata-extractor-images: ~420 camera test samples
    - COCO 2017 (via FiftyOne): 300 photos for object detection testing
    - LFW (via FiftyOne): 200 face images (optional, often fails due to SSL)

Output:
    e2e/fixtures/large-testset/
    ├── photos/           # All downloaded photos
    ├── manifest.json     # Dataset metadata
    └── duplicates.json   # Czkawka duplicate detection results
EOF
}

clean_testdata() {
	print_header "Cleaning Test Data"

	if [ -d "$PROJECT_ROOT/e2e/fixtures/large-testset" ]; then
		print_step "Removing large-testset/"
		rm -rf "$PROJECT_ROOT/e2e/fixtures/large-testset"
		print_step "Done"
	else
		print_step "No test data to clean"
	fi
}

verify_testdata() {
	print_header "Verifying Test Data"

	local photos_dir="$PROJECT_ROOT/e2e/fixtures/large-testset/photos"

	if [ ! -d "$photos_dir" ]; then
		print_error "Test data not found. Run setup first."
		exit 1
	fi

	echo ""
	echo "Total photos:"
	ls -1 "$photos_dir"/*.jpg 2>/dev/null | wc -l

	echo ""
	echo "Photos with GPS:"
	exiftool -if '$GPSLatitude' -p '$filename' "$photos_dir"/*.jpg 2>/dev/null | wc -l

	echo ""
	echo "Photos with DateTimeOriginal:"
	exiftool -if '$DateTimeOriginal' -p '$filename' "$photos_dir"/*.jpg 2>/dev/null | wc -l

	echo ""
	echo "Photos with Camera Make:"
	exiftool -if '$Make' -p '$filename' "$photos_dir"/*.jpg 2>/dev/null | wc -l

	echo ""
	echo "COCO images:"
	ls -1 "$photos_dir"/coco_*.jpg 2>/dev/null | wc -l

	echo ""
	echo "Total size:"
	du -sh "$PROJECT_ROOT/e2e/fixtures/large-testset/"
}

# Parse arguments
ONLY_FLAG=""
SKIP_DUPLICATES=""

case "$1" in
--help | -h)
	show_help
	exit 0
	;;
quick)
	ONLY_FLAG="--only exif,metadata"
	;;
clean)
	clean_testdata
	exit 0
	;;
verify)
	verify_testdata
	exit 0
	;;
--no-coco)
	ONLY_FLAG="--only exif,metadata,lfw"
	;;
--no-lfw)
	ONLY_FLAG="--only exif,metadata,coco"
	;;
esac

# Main execution
check_dependencies

print_header "Running Test Data Setup"

cd "$PROJECT_ROOT"
python3 scripts/setup-testdata-large.py $ONLY_FLAG $SKIP_DUPLICATES

print_header "Setup Complete"

# Show summary
verify_testdata
