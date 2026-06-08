#!/bin/bash
# setup-testdata-geo.sh
# Downloads real geotagged test photos from established test libraries
#
# Sources:
#   - ianare/exif-samples: GPS folder with real geotagged images
#   - drewnoakes/metadata-extractor-images: Comprehensive camera samples
#
# Output:
#   e2e/fixtures/geo-test/photos/*.jpg

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE_DIR="$SCRIPT_DIR/../e2e/fixtures/geo-test"
PHOTOS_DIR="$FIXTURE_DIR/photos"

echo "=== Downloading Real Geotagged Test Photos ==="

rm -rf "$FIXTURE_DIR"
mkdir -p "$PHOTOS_DIR"

EXIF_SAMPLES_URL="https://github.com/ianare/exif-samples/archive/refs/heads/master.zip"
TEMP_DIR=$(mktemp -d)

echo "Downloading ianare/exif-samples..."
curl -L -o "$TEMP_DIR/exif-samples.zip" "$EXIF_SAMPLES_URL"
unzip -o -q "$TEMP_DIR/exif-samples.zip" "exif-samples-master/jpg/*" -d "$TEMP_DIR" 2>/dev/null || true

echo "Extracting GPS samples..."
GPS_DIR="$TEMP_DIR/exif-samples-master/jpg/gps"
if [ -d "$GPS_DIR" ]; then
	cp "$GPS_DIR"/*.jpg "$PHOTOS_DIR/" 2>/dev/null || true
	cp "$GPS_DIR"/*.JPG "$PHOTOS_DIR/" 2>/dev/null || true
fi

echo "Extracting additional samples with EXIF..."
EXIF_DIR="$TEMP_DIR/exif-samples-master/jpg"
for subdir in Canon Nikon Apple Samsung; do
	if [ -d "$EXIF_DIR/$subdir" ]; then
		find "$EXIF_DIR/$subdir" -name "*.jpg" -o -name "*.JPG" | head -3 | while read f; do
			cp "$f" "$PHOTOS_DIR/"
		done
	fi
done

cp "$EXIF_DIR"/*.jpg "$PHOTOS_DIR/" 2>/dev/null || true

echo "Downloading additional samples from drewnoakes/metadata-extractor-images..."
METADATA_EXTRACTOR_RAW="https://raw.githubusercontent.com/drewnoakes/metadata-extractor-images/master"

declare -a SAMPLE_IMAGES=(
	"jpg/Apple%20iPhone%204S.jpg"
	"jpg/Apple%20iPhone%206.jpg"
	"jpg/Nikon%20D70.jpg"
	"jpg/Canon%20EOS%2040D.jpg"
	"jpg/Sony%20Cybershot.jpg"
)

for img in "${SAMPLE_IMAGES[@]}"; do
	filename=$(basename "$img" | sed 's/%20/_/g')
	echo "  Downloading $filename..."
	curl -L -s -o "$PHOTOS_DIR/$filename" "$METADATA_EXTRACTOR_RAW/$img" 2>/dev/null || true
done

rm -rf "$TEMP_DIR"

echo ""
echo "Creating manifest.json..."
cat >"$FIXTURE_DIR/manifest.json" <<'EOF'
{
  "name": "geo-test",
  "description": "Real geotagged photos from ianare/exif-samples and drewnoakes/metadata-extractor-images",
  "sources": [
    "https://github.com/ianare/exif-samples",
    "https://github.com/drewnoakes/metadata-extractor-images"
  ],
  "purpose": "Testing M7 (Places), M8 (Weather), M9 (Map), M5 (Metadata Merge)"
}
EOF

echo ""
echo "=== Geo Test Fixtures Downloaded ==="
echo "Total files: $(ls -1 "$PHOTOS_DIR"/*.jpg "$PHOTOS_DIR"/*.JPG 2>/dev/null | wc -l | tr -d ' ')"
echo ""
echo "Verifying GPS data in samples:"
exiftool -GPSLatitude -GPSLongitude -DateTimeOriginal "$PHOTOS_DIR"/*.jpg 2>/dev/null | head -40
