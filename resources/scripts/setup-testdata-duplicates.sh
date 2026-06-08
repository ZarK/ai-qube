#!/bin/bash
# setup-testdata-duplicates.sh
# Downloads real test photos for duplicate detection testing
#
# Sources:
#   - ianare/exif-samples: Various camera samples
#   - Creates actual duplicates by copying and resizing real images
#
# Output:
#   e2e/fixtures/duplicates/photos/*.jpg

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE_DIR="$SCRIPT_DIR/../e2e/fixtures/duplicates"
PHOTOS_DIR="$FIXTURE_DIR/photos"

echo "=== Setting Up Duplicate Test Fixtures ==="

mkdir -p "$PHOTOS_DIR"

EXIF_SAMPLES_URL="https://github.com/ianare/exif-samples/archive/refs/heads/master.zip"
TEMP_DIR=$(mktemp -d)

echo "Downloading ianare/exif-samples..."
curl -L -o "$TEMP_DIR/exif-samples.zip" "$EXIF_SAMPLES_URL"
unzip -o -q "$TEMP_DIR/exif-samples.zip" "exif-samples-master/jpg/*" -d "$TEMP_DIR" 2>/dev/null || true

EXIF_DIR="$TEMP_DIR/exif-samples-master/jpg"

echo "Selecting high-quality original images..."
ORIGINAL=$(find "$EXIF_DIR" -name "*.jpg" -size +100k | head -1)

if [ -n "$ORIGINAL" ]; then
	echo "Using $ORIGINAL as source for duplicate creation..."

	cp "$ORIGINAL" "$PHOTOS_DIR/original_highres.jpg"

	echo "Creating exact duplicate..."
	cp "$ORIGINAL" "$PHOTOS_DIR/exact_duplicate.jpg"

	echo "Creating resized duplicate (lower resolution)..."
	if command -v magick &>/dev/null; then
		magick "$ORIGINAL" -resize 50% "$PHOTOS_DIR/resized_duplicate.jpg"
	elif command -v convert &>/dev/null; then
		convert "$ORIGINAL" -resize 50% "$PHOTOS_DIR/resized_duplicate.jpg"
	else
		echo "Warning: ImageMagick not found, skipping resized duplicate"
		cp "$ORIGINAL" "$PHOTOS_DIR/resized_duplicate.jpg"
	fi

	echo "Creating copy with different name..."
	cp "$ORIGINAL" "$PHOTOS_DIR/IMG_copy_001.jpg"
fi

echo "Adding unrelated images..."
UNRELATED=$(find "$EXIF_DIR" -name "*.jpg" -size +50k | tail -3)
COUNT=1
for img in $UNRELATED; do
	cp "$img" "$PHOTOS_DIR/unrelated_${COUNT}.jpg"
	COUNT=$((COUNT + 1))
done

rm -rf "$TEMP_DIR"

echo ""
echo "Creating czkawka.json fixture..."
cat >"$FIXTURE_DIR/czkawka.json" <<'EOF'
{
  "duplicateGroups": [
    {
      "type": "exact",
      "files": [
        { "relativePath": "photos/original_highres.jpg" },
        { "relativePath": "photos/exact_duplicate.jpg" },
        { "relativePath": "photos/IMG_copy_001.jpg" }
      ]
    }
  ],
  "similarGroups": [
    {
      "type": "similar",
      "similarity": 95,
      "files": [
        { "relativePath": "photos/original_highres.jpg" },
        { "relativePath": "photos/resized_duplicate.jpg" }
      ]
    }
  ]
}
EOF

echo "Creating manifest.json..."
cat >"$FIXTURE_DIR/manifest.json" <<'EOF'
{
  "name": "duplicates",
  "description": "Real images with exact and similar duplicates for M3 testing",
  "source": "https://github.com/ianare/exif-samples",
  "expected": {
    "exactDuplicateGroups": 1,
    "similarGroups": 1,
    "canonicalSelection": "original_highres.jpg"
  }
}
EOF

echo ""
echo "=== Duplicate Test Fixtures Created ==="
echo "Total files: $(ls -1 "$PHOTOS_DIR"/*.jpg 2>/dev/null | wc -l | tr -d ' ')"
ls -la "$PHOTOS_DIR"
