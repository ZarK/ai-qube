#!/bin/bash
# setup-testdata-metadata.sh
# Downloads real test photos with varied metadata for M5 testing
#
# Sources:
#   - ianare/exif-samples: Various metadata scenarios
#   - drewnoakes/metadata-extractor-images: Comprehensive camera samples
#
# Purpose: Testing metadata merge, provenance tracking, conflict resolution
#
# Output:
#   e2e/fixtures/metadata-merge/photos/*.jpg
#   e2e/fixtures/metadata-merge/sidecars/*.xmp
#   e2e/fixtures/metadata-merge/takeout/*.json

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE_DIR="$SCRIPT_DIR/../e2e/fixtures/metadata-merge"
PHOTOS_DIR="$FIXTURE_DIR/photos"
SIDECARS_DIR="$FIXTURE_DIR/sidecars"
TAKEOUT_DIR="$FIXTURE_DIR/takeout"

echo "=== Setting Up Metadata Merge Test Fixtures ==="

rm -rf "$FIXTURE_DIR"
mkdir -p "$PHOTOS_DIR" "$SIDECARS_DIR" "$TAKEOUT_DIR"

EXIF_SAMPLES_URL="https://github.com/ianare/exif-samples/archive/refs/heads/master.zip"
TEMP_DIR=$(mktemp -d)

echo "Downloading ianare/exif-samples..."
curl -L -o "$TEMP_DIR/exif-samples.zip" "$EXIF_SAMPLES_URL"
unzip -o -q "$TEMP_DIR/exif-samples.zip" "exif-samples-master/jpg/*" -d "$TEMP_DIR" 2>/dev/null || true

EXIF_DIR="$TEMP_DIR/exif-samples-master/jpg"

echo "Selecting images with varied metadata..."

if [ -d "$EXIF_DIR/gps" ]; then
	GPS_IMG=$(find "$EXIF_DIR/gps" -name "*.jpg" | head -1)
	if [ -n "$GPS_IMG" ]; then
		cp "$GPS_IMG" "$PHOTOS_DIR/gps_and_exif.jpg"
	fi
fi

EXIF_ONLY=$(find "$EXIF_DIR" -name "*.jpg" ! -path "*/gps/*" -size +50k | head -1)
if [ -n "$EXIF_ONLY" ]; then
	cp "$EXIF_ONLY" "$PHOTOS_DIR/exif_datetime_only.jpg"
fi

EXIF_NO_GPS=$(find "$EXIF_DIR" -name "*.jpg" ! -path "*/gps/*" -size +30k | tail -1)
if [ -n "$EXIF_NO_GPS" ]; then
	cp "$EXIF_NO_GPS" "$PHOTOS_DIR/filename_date_pattern.jpg"
fi

for subdir in Canon Nikon Apple Samsung Sony; do
	if [ -d "$EXIF_DIR/$subdir" ]; then
		SAMPLE=$(find "$EXIF_DIR/$subdir" -name "*.jpg" | head -1)
		if [ -n "$SAMPLE" ]; then
			cp "$SAMPLE" "$PHOTOS_DIR/${subdir}_sample.jpg"
		fi
	fi
done

rm -rf "$TEMP_DIR"

echo "Creating XMP sidecar for testing..."
cat >"$SIDECARS_DIR/gps_and_exif.xmp" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:xmp="http://ns.adobe.com/xap/1.0/"
      xmlns:dc="http://purl.org/dc/elements/1.1/"
      xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/">
      <xmp:CreateDate>2023-06-15T14:30:00</xmp:CreateDate>
      <dc:title>
        <rdf:Alt>
          <rdf:li xml:lang="x-default">XMP Sidecar Test</rdf:li>
        </rdf:Alt>
      </dc:title>
      <photoshop:City>Test City from XMP</photoshop:City>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
EOF

echo "Creating Google Takeout JSON sidecar..."
cat >"$TAKEOUT_DIR/exif_datetime_only.jpg.json" <<'EOF'
{
  "title": "exif_datetime_only.jpg",
  "description": "Photo from Google Takeout",
  "imageViews": "42",
  "creationTime": {
    "timestamp": "1686840600",
    "formatted": "Jun 15, 2023, 2:30:00 PM UTC"
  },
  "photoTakenTime": {
    "timestamp": "1686840600",
    "formatted": "Jun 15, 2023, 2:30:00 PM UTC"
  },
  "geoData": {
    "latitude": 48.8584,
    "longitude": 2.2945,
    "altitude": 35.0,
    "latitudeSpan": 0.0,
    "longitudeSpan": 0.0
  },
  "geoDataExif": {
    "latitude": 48.8584,
    "longitude": 2.2945,
    "altitude": 35.0,
    "latitudeSpan": 0.0,
    "longitudeSpan": 0.0
  }
}
EOF

echo "Creating manifest.json..."
cat >"$FIXTURE_DIR/manifest.json" <<'EOF'
{
  "name": "metadata-merge",
  "description": "Real images with varied metadata sources for M5 testing",
  "sources": [
    "https://github.com/ianare/exif-samples"
  ],
  "purpose": "Testing metadata extraction, precedence rules, conflict resolution, audit trail",
  "scenarios": {
    "gps_and_exif.jpg": "Image with both GPS timestamp and EXIF - GPS should win",
    "exif_datetime_only.jpg": "Image with EXIF only - has Takeout JSON sidecar",
    "filename_date_pattern.jpg": "Image where filename contains date pattern"
  }
}
EOF

echo "Creating expected.json..."
cat >"$FIXTURE_DIR/expected.json" <<'EOF'
{
  "precedenceTests": {
    "gps_and_exif.jpg": {
      "expectedDateSource": "gps",
      "hasXMPSidecar": true
    },
    "exif_datetime_only.jpg": {
      "expectedDateSource": "exif",
      "hasTakeoutJSON": true,
      "takeoutProvidesGPS": true
    }
  }
}
EOF

echo ""
echo "=== Metadata Merge Test Fixtures Created ==="
echo "Photos: $(ls -1 "$PHOTOS_DIR"/*.jpg 2>/dev/null | wc -l | tr -d ' ')"
echo "Sidecars: $(ls -1 "$SIDECARS_DIR"/*.xmp 2>/dev/null | wc -l | tr -d ' ')"
echo "Takeout JSONs: $(ls -1 "$TAKEOUT_DIR"/*.json 2>/dev/null | wc -l | tr -d ' ')"
echo ""
echo "Photo metadata:"
exiftool -DateTimeOriginal -GPSLatitude -Make -Model "$PHOTOS_DIR"/*.jpg 2>/dev/null | head -40
