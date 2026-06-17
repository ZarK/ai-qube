#!/usr/bin/env bash
set -euo pipefail
trap 'echo "ERROR line $LINENO: $BASH_COMMAND" >&2' ERR

ROOT="${1:-./testdata}"
SEED_DIR="$ROOT/_seed"
BASE_DIR="$ROOT/base"
CASES_DIR="$ROOT/cases"
DUP_DIR="$ROOT/duplicates"
NOISE_DIR="$ROOT/noise"

SYNO_SUFFIXES="@synoresource @synoeastream"

mkdir -p "$SEED_DIR" "$BASE_DIR" "$CASES_DIR" "$DUP_DIR" "$NOISE_DIR"

need() { command -v "$1" >/dev/null 2>&1; }
log()  { printf "\n==> %s\n" "$*"; }

fast_cp() {
  # APFS clone copy (instant, copy-on-write). Falls back to normal cp.
  cp -c "$1" "$2" 2>/dev/null || cp -f "$1" "$2"
}

HAS_FFMPEG=0; need ffmpeg && HAS_FFMPEG=1
HAS_MAGICK=0; (need magick || need convert) && HAS_MAGICK=1
MAGICK_BIN=""
if need magick; then MAGICK_BIN="magick"; elif need convert; then MAGICK_BIN="convert"; fi

require_tools() {
  if ! need git; then
    echo "ERROR: git is required."
    exit 1
  fi
  if ! need exiftool; then
    echo "ERROR: exiftool is required. Install: brew install exiftool"
    exit 1
  fi
}

fetch_seeds() {
  log "Fetching seed media into $SEED_DIR"

  if [ ! -d "$SEED_DIR/mediaelement-files" ]; then
    git clone --depth 1 https://github.com/mediaelement/mediaelement-files \
      "$SEED_DIR/mediaelement-files" >/dev/null 2>&1 || true
  fi

  if [ ! -d "$SEED_DIR/exif-samples" ]; then
    git clone --depth 1 https://github.com/ianare/exif-samples \
      "$SEED_DIR/exif-samples" >/dev/null 2>&1 || true
  fi

  if [ ! -f "$SEED_DIR/mediaelement-files/big_buck_bunny.mp4" ]; then
    log "mediaelement repo missing; downloading minimal seeds via raw URLs"
    curl -L --fail -o "$SEED_DIR/big_buck_bunny.mp4" \
      "https://raw.githubusercontent.com/mediaelement/mediaelement-files/master/big_buck_bunny.mp4"
    curl -L --fail -o "$SEED_DIR/big_buck_bunny.webm" \
      "https://raw.githubusercontent.com/mediaelement/mediaelement-files/master/big_buck_bunny.webm"
    curl -L --fail -o "$SEED_DIR/echo-hereweare.ogv" \
      "https://raw.githubusercontent.com/mediaelement/mediaelement-files/master/echo-hereweare.ogv"
    curl -L --fail -o "$SEED_DIR/guqin.flv" \
      "https://raw.githubusercontent.com/mediaelement/mediaelement-files/master/guqin.flv"
  fi

  if [ ! -f "$SEED_DIR/sample.dng" ]; then
    curl -L --fail -o "$SEED_DIR/sample.dng" \
      "https://raw.githubusercontent.com/akucherenko/dng/master/sample.dng" || true
  fi

  if [ ! -f "$SEED_DIR/sample_640x426.psd" ]; then
    curl -L --fail -o "$SEED_DIR/sample_640x426.psd" \
      "https://filesamples.com/samples/image/psd/sample_640%C3%97426.psd" || true
  fi

  log "Seed fetch complete"
}

make_base_media() {
  log "Building base media set under $BASE_DIR"
  mkdir -p "$BASE_DIR/images" "$BASE_DIR/videos"

  # Find seed jpg
  local SEED_JPG=""
  if [ -d "$SEED_DIR/exif-samples/jpg" ]; then
    SEED_JPG="$(find "$SEED_DIR/exif-samples/jpg" -maxdepth 1 -type f -iname '*.jpg' | head -n 1 || true)"
  fi
  if [ -z "${SEED_JPG:-}" ] && [ -f "$SEED_DIR/mediaelement-files/big_buck_bunny.jpg" ]; then
    SEED_JPG="$SEED_DIR/mediaelement-files/big_buck_bunny.jpg"
  fi
  if [ -z "${SEED_JPG:-}" ]; then
    echo "ERROR: Could not find a seed JPG."
    exit 1
  fi
  cp -f "$SEED_JPG" "$BASE_DIR/images/seed.jpg"
  cp -f "$BASE_DIR/images/seed.jpg" "$BASE_DIR/images/seed.jpeg" || true

  # Seed mp4
  if [ -f "$SEED_DIR/mediaelement-files/big_buck_bunny.mp4" ]; then
    cp -f "$SEED_DIR/mediaelement-files/big_buck_bunny.mp4" "$BASE_DIR/videos/seed.mp4"
  else
    cp -f "$SEED_DIR/big_buck_bunny.mp4" "$BASE_DIR/videos/seed.mp4"
  fi

  # Make mp4 tiny for speed (exiftool rewrites files)
  if [ "$HAS_FFMPEG" -eq 1 ]; then
    log "Creating tiny 2s MP4 seed for fast metadata rewriting"
    ffmpeg -y -i "$BASE_DIR/videos/seed.mp4" -t 2 -vf "scale=640:-2" -an \
      "$BASE_DIR/videos/seed_small.mp4" >/dev/null 2>&1 || true
    if [ -f "$BASE_DIR/videos/seed_small.mp4" ]; then
      mv -f "$BASE_DIR/videos/seed_small.mp4" "$BASE_DIR/videos/seed.mp4"
    fi
  fi

  # Copy other seeds if present
  [ -f "$SEED_DIR/mediaelement-files/big_buck_bunny.webm" ] && cp -f "$SEED_DIR/mediaelement-files/big_buck_bunny.webm" "$BASE_DIR/videos/seed.webm" || true
  [ -f "$SEED_DIR/mediaelement-files/echo-hereweare.ogv" ] && cp -f "$SEED_DIR/mediaelement-files/echo-hereweare.ogv" "$BASE_DIR/videos/seed.ogv" || true
  [ -f "$SEED_DIR/mediaelement-files/guqin.flv" ] && cp -f "$SEED_DIR/mediaelement-files/guqin.flv" "$BASE_DIR/videos/seed.flv" || true

  # Extra image formats
  if [ "$HAS_MAGICK" -eq 1 ]; then
    log "Generating derived image formats using ImageMagick ($MAGICK_BIN)"
    "$MAGICK_BIN" "$BASE_DIR/images/seed.jpg" "$BASE_DIR/images/seed.png"  >/dev/null 2>&1 || true
    "$MAGICK_BIN" "$BASE_DIR/images/seed.jpg" "$BASE_DIR/images/seed.bmp"  >/dev/null 2>&1 || true
    "$MAGICK_BIN" "$BASE_DIR/images/seed.jpg" "$BASE_DIR/images/seed.gif"  >/dev/null 2>&1 || true
    "$MAGICK_BIN" "$BASE_DIR/images/seed.jpg" "$BASE_DIR/images/seed.tiff" >/dev/null 2>&1 || true
    "$MAGICK_BIN" "$BASE_DIR/images/seed.jpg" "$BASE_DIR/images/seed.webp" >/dev/null 2>&1 || true
    "$MAGICK_BIN" "$BASE_DIR/images/seed.jpg" "$BASE_DIR/images/seed.jp2"  >/dev/null 2>&1 || true
    "$MAGICK_BIN" "$BASE_DIR/images/seed.jpg" "$BASE_DIR/images/seed.avif" >/dev/null 2>&1 || true
    "$MAGICK_BIN" "$BASE_DIR/images/seed.jpg" "$BASE_DIR/images/seed.heic" >/dev/null 2>&1 || true
    "$MAGICK_BIN" "$BASE_DIR/images/seed.jpg" "$BASE_DIR/images/seed.psd"  >/dev/null 2>&1 || true
  fi

  # DNG / PSD seeds
  [ -f "$SEED_DIR/sample.dng" ] && cp -f "$SEED_DIR/sample.dng" "$BASE_DIR/images/seed.dng" || true
  [ -f "$SEED_DIR/sample_640x426.psd" ] && cp -f "$SEED_DIR/sample_640x426.psd" "$BASE_DIR/images/seed.psd" || true

  # APNG sample: true animated if ffmpeg available, else fallback
  if [ "$HAS_FFMPEG" -eq 1 ]; then
    log "Generating APNG sample (animated) with ffmpeg"
    mkdir -p "$BASE_DIR/images/_apng_tmp"
    if [ "$HAS_MAGICK" -eq 1 ]; then
      "$MAGICK_BIN" "$BASE_DIR/images/seed.jpg" -resize 256x256 "$BASE_DIR/images/_apng_tmp/f%03d.png" >/dev/null 2>&1 || true
    else
      # no magick, just create a few identical png frames if seed.png exists
      if [ -f "$BASE_DIR/images/seed.png" ]; then
        cp -f "$BASE_DIR/images/seed.png" "$BASE_DIR/images/_apng_tmp/f000.png" || true
        cp -f "$BASE_DIR/images/seed.png" "$BASE_DIR/images/_apng_tmp/f001.png" || true
        cp -f "$BASE_DIR/images/seed.png" "$BASE_DIR/images/_apng_tmp/f002.png" || true
      fi
    fi
    ffmpeg -y -framerate 2 -i "$BASE_DIR/images/_apng_tmp/f%03d.png" -plays 0 \
      "$BASE_DIR/images/seed.apng" >/dev/null 2>&1 || true
    rm -rf "$BASE_DIR/images/_apng_tmp" || true
  else
    [ -f "$BASE_DIR/images/seed.png" ] && cp -f "$BASE_DIR/images/seed.png" "$BASE_DIR/images/seed.apng" || true
  fi

  # Video container variants (best effort)
  if [ "$HAS_FFMPEG" -eq 1 ]; then
    log "Generating derived video formats using ffmpeg"
    ffmpeg -y -i "$BASE_DIR/videos/seed.mp4" -c copy "$BASE_DIR/videos/seed.m4v" >/dev/null 2>&1 || true
    ffmpeg -y -i "$BASE_DIR/videos/seed.mp4" -c copy "$BASE_DIR/videos/seed.mov" >/dev/null 2>&1 || true
    ffmpeg -y -i "$BASE_DIR/videos/seed.mp4" -c copy "$BASE_DIR/videos/seed.mkv" >/dev/null 2>&1 || true
    ffmpeg -y -i "$BASE_DIR/videos/seed.mp4" "$BASE_DIR/videos/seed.avi"  >/dev/null 2>&1 || true
    ffmpeg -y -i "$BASE_DIR/videos/seed.mp4" "$BASE_DIR/videos/seed.mpg"  >/dev/null 2>&1 || true
    ffmpeg -y -i "$BASE_DIR/videos/seed.mp4" "$BASE_DIR/videos/seed.wmv"  >/dev/null 2>&1 || true
    ffmpeg -y -i "$BASE_DIR/videos/seed.mp4" "$BASE_DIR/videos/seed.webm" >/dev/null 2>&1 || true
    ffmpeg -y -i "$BASE_DIR/videos/seed.mp4" "$BASE_DIR/videos/seed.ogv"  >/dev/null 2>&1 || true
    ffmpeg -y -i "$BASE_DIR/videos/seed.mp4" "$BASE_DIR/videos/seed.flv"  >/dev/null 2>&1 || true
    ffmpeg -y -i "$BASE_DIR/videos/seed.mp4" "$BASE_DIR/videos/seed.mxf"  >/dev/null 2>&1 || true
    ffmpeg -y -i "$BASE_DIR/videos/seed.mp4" "$BASE_DIR/videos/seed.mts"  >/dev/null 2>&1 || true
    cp -f "$BASE_DIR/videos/seed.mp4" "$BASE_DIR/videos/seed.lrv" || true
  fi

  log "Base media build done"
}

touch_mtime() {
  local f="$1" ymdhms="$2"
  local t="${ymdhms:0:12}.${ymdhms:12:2}"
  touch -t "$t" "$f" 2>/dev/null || true
}

write_google_takeout_json() {
  local media="$1" ts="$2" lat="$3" lon="$4"
  cat > "${media}.json" <<EOF
{
  "title": "$(basename "$media")",
  "photoTakenTime": { "timestamp": "$ts", "formatted": "" },
  "geoData": { "latitude": $lat, "longitude": $lon, "altitude": 12.3 },
  "geoDataExif": { "latitude": $lat, "longitude": $lon, "altitude": 12.3 }
}
EOF
}

write_xmp_sidecar() {
  local media="$1" iso="$2" lat="$3" lon="$4"
  cat > "${media}.xmp" <<EOF
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:exif="http://ns.adobe.com/exif/1.0/"
    xmp:CreateDate="$iso"
    xmp:ModifyDate="$iso">
    <exif:GPSLatitude>$lat</exif:GPSLatitude>
    <exif:GPSLongitude>$lon</exif:GPSLongitude>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
EOF
}

apply_exif_like_metadata() {
  local f="$1" dt="$2" tz="$3" lat="$4" lon="$5"
  exiftool -overwrite_original \
    "-DateTimeOriginal=${dt}${tz}" \
    "-CreateDate=${dt}${tz}" \
    "-ModifyDate=${dt}${tz}" \
    "-XMP:CreateDate=${dt}${tz}" \
    "-XMP:ModifyDate=${dt}${tz}" \
    "-IPTC:DateCreated=${dt:0:10}" \
    "-IPTC:TimeCreated=${dt:11:8}" \
    "-GPSLatitude=$lat" "-GPSLongitude=$lon" \
    "-GPSLatitudeRef=N" "-GPSLongitudeRef=E" \
    "$f" >/dev/null 2>&1 || true
}

apply_quicktime_dates() {
  local f="$1" dt="$2" tz="$3"
  exiftool -overwrite_original \
    "-QuickTime:CreateDate=${dt}${tz}" \
    "-QuickTime:ModifyDate=${dt}${tz}" \
    "-TrackCreateDate=${dt}${tz}" \
    "-MediaCreateDate=${dt}${tz}" \
    "-TrackModifyDate=${dt}${tz}" \
    "-MediaModifyDate=${dt}${tz}" \
    "$f" >/dev/null 2>&1 || true
}

strip_metadata() { exiftool -overwrite_original -all= "$1" >/dev/null 2>&1 || true; }

add_spam_metadata() {
  local f="$1"
  exiftool -overwrite_original \
    "-Software=SomeCloudSync 9.9.9 (spam)" \
    "-XMP:CreatorTool=AI Photo Enhancer Ultra (spam)" \
    "-XMP:Description=Downloaded from social media (spam)" \
    "-XMP:History=Edited 17 times (spam)" \
    "$f" >/dev/null 2>&1 || true
}

mkpath_from_pattern() {
  local root="$1" pat="$2" y="$3" m="$4" d="$5" hms="$6"
  case "$pat" in
    "YYYY/MM/DD")        echo "$root/$y/$m/$d" ;;
    "YYYY/MM")           echo "$root/$y/$m" ;;
    "YYYYMMDD")          echo "$root/${y}${m}${d}" ;;
    "YYYY-MM-DD")        echo "$root/${y}-${m}-${d}" ;;
    "YYYY/MM/DD/HHmmss") echo "$root/$y/$m/$d/$hms" ;;
    *)                   echo "$root/misc" ;;
  esac
}

mkname_from_pattern() {
  local pat="$1" y="$2" m="$3" d="$4" hh="$5" mm="$6" ss="$7"
  local ymd="${y}${m}${d}"
  local hms="${hh}${mm}${ss}"
  case "$pat" in
    "IMG_YYYYMMDD_HHMMSS")     echo "IMG_${ymd}_${hms}" ;;
    "YYYY-MM-DDTHHMMSSZ")      echo "${y}-${m}-${d}T${hh}${mm}${ss}Z" ;;
    "YYYYMMDDHHMMSS")          echo "${ymd}${hms}" ;;
    "PXL_YYYYMMDD_HHMMSSmmm")  echo "PXL_${ymd}_${hh}${mm}${ss}123" ;;
    "VID-YYYYMMDD-WA0001")     echo "VID-${ymd}-WA0001" ;;
    *)                         echo "FILE_${ymd}_${hms}" ;;
  esac
}

make_cases() {
  log "Generating permutation library under $CASES_DIR and duplicate groups under $DUP_DIR"

  local DT1="2003:07:04 12:34:56" TZ1="+02:00"
  local DT2="2011:11:11 01:02:03" TZ2="+00:00"
  local BAD="1970:01:01 00:00:00" TZB="+00:00"
  local LAT="59.9139" LON="10.7522"

  local PATH_PATTERNS="YYYY/MM/DD YYYY/MM YYYYMMDD YYYY-MM-DD YYYY/MM/DD/HHmmss"
  local NAME_PATTERNS="IMG_YYYYMMDD_HHMMSS YYYY-MM-DDTHHMMSSZ YYYYMMDDHHMMSS PXL_YYYYMMDD_HHMMSSmmm VID-YYYYMMDD-WA0001"

  local BASE_IMAGES BASE_VIDEOS
  BASE_IMAGES="$(find "$BASE_DIR/images" -maxdepth 1 -type f | sort)"
  BASE_VIDEOS="$(find "$BASE_DIR/videos" -maxdepth 1 -type f | sort)"

  [ -z "$BASE_IMAGES" ] && { echo "ERROR: No base images found."; return 1; }
  [ -z "$BASE_VIDEOS" ] && { echo "ERROR: No base videos found."; return 1; }

  local IMG6 VID6
  IMG6="$(printf '%s\n' "$BASE_IMAGES" | head -n 6)"
  VID6="$(printf '%s\n' "$BASE_VIDEOS" | head -n 6)"

  local GROUP_TYPES="G1 G2 G3"
  local gid=0

  for g in $GROUP_TYPES; do
    for src in $IMG6 $VID6; do
      gid=$((gid+1))
      local ext="${src##*.}"
      local base="group$(printf "%03d" "$gid")_${g}"
      local outdir="$DUP_DIR/$base"
      mkdir -p "$outdir"

      local best="$outdir/${base}_BEST.${ext}"
      local donor="$outdir/${base}_DONOR.${ext}"
      local third="$outdir/${base}_THIRD.${ext}"

      log "Creating $base from $(basename "$src")"
      fast_cp "$src" "$best"
      fast_cp "$src" "$donor"
      fast_cp "$src" "$third"

      apply_exif_like_metadata "$best" "$BAD" "$TZB" "$LAT" "$LON"
      add_spam_metadata "$best"

      if [ "$g" = "G3" ]; then
        apply_exif_like_metadata "$donor" "$DT2" "$TZ2" "$LAT" "$LON"
      else
        apply_exif_like_metadata "$donor" "$DT1" "$TZ1" "$LAT" "$LON"
      fi

      strip_metadata "$third"

      case "$ext" in
        mp4|mov|m4v)
          apply_quicktime_dates "$best" "$BAD" "$TZB"
          if [ "$g" = "G3" ]; then
            apply_quicktime_dates "$donor" "$DT2" "$TZ2"
          else
            apply_quicktime_dates "$donor" "$DT1" "$TZ1"
          fi
          ;;
      esac

      if [ "$g" = "G2" ]; then
        write_google_takeout_json "$third" "1057314896" "$LAT" "$LON"
      fi
      if [ "$g" = "G1" ]; then
        write_xmp_sidecar "$donor" "2003-07-04T12:34:56+02:00" "$LAT" "$LON"
      fi

      # Create path+filename permutations from THIRD
      local y="2020" m="01" d="02" hh="03" mi="04" ss="05"
      local hms="${hh}${mi}${ss}"

      for pp in $PATH_PATTERNS; do
        for np in $NAME_PATTERNS; do
          local pdir; pdir="$(mkpath_from_pattern "$CASES_DIR/$base" "$pp" "$y" "$m" "$d" "$hms")"
          mkdir -p "$pdir"
          local fname; fname="$(mkname_from_pattern "$np" "$y" "$m" "$d" "$hh" "$mi" "$ss")"
          local target="$pdir/${fname}.${ext}"

          fast_cp "$third" "$target"
          touch_mtime "$target" "20200102030405"

          for suf in $SYNO_SUFFIXES; do
            fast_cp "$target" "$pdir/${fname}.${ext}${suf}" 2>/dev/null || true
          done
        done
      done
    done
  done

  log "Creating noise/junk files under $NOISE_DIR"
  printf "not media\n" > "$NOISE_DIR/desktop.ini"
  printf "{}\n" > "$NOISE_DIR/index.json"
  printf "<xmpmeta/>\n" > "$NOISE_DIR/random.xmp"
  printf "sqlite\n" > "$NOISE_DIR/library.db"
  printf "tmp\n" > "$NOISE_DIR/file.tmp"
  printf "lr preview\n" > "$NOISE_DIR/sample.lrprev"
  printf "lr fpreview\n" > "$NOISE_DIR/sample.lrfprev"
  printf "AAE placeholder\n" > "$NOISE_DIR/IMG_20200102_030405.AAE"

  log "Done. Duplicate groups: $DUP_DIR, Permutation cases: $CASES_DIR"
}

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g; s/\r/\\r/g; s/\n/\\n/g'; }

write_manifest() {
  local manifest="$ROOT/manifest.json"
  log "Writing manifest: $manifest"

  local genAt; genAt="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  local CASES_ISO_NAIVE="2020-01-02T03:04:05"
  local CASES_ISO_Z="2020-01-02T03:04:05Z"

  {
    printf '{\n'
    printf '  "generatedAt": "%s",\n' "$(json_escape "$genAt")"
    printf '  "root": "%s",\n' "$(json_escape "$ROOT")"
    printf '  "ignoreRules": {\n'
    printf '    "synologySuffixes": ["@synoresource","@synoeastream"],\n'
    printf '    "treatSynologyVariantsAsDerivatives": true,\n'
    printf '    "sidecarExtensions": ["json","xmp","thm","aae"]\n'
    printf '  },\n'

    printf '  "duplicateGroups": [\n'
    local firstGroup=1
    for gdir in "$DUP_DIR"/*; do
      [ -d "$gdir" ] || continue
      local base; base="$(basename "$gdir")"
      local type="UNKNOWN"
      case "$base" in
        *_G1) type="G1" ;;
        *_G2) type="G2" ;;
        *_G3) type="G3" ;;
      esac

      local best donor third
      best="$(find "$gdir" -maxdepth 1 -type f -name "*_BEST.*" | head -n 1 || true)"
      donor="$(find "$gdir" -maxdepth 1 -type f -name "*_DONOR.*" | head -n 1 || true)"
      third="$(find "$gdir" -maxdepth 1 -type f -name "*_THIRD.*" | head -n 1 || true)"

      if [ $firstGroup -eq 0 ]; then printf ',\n'; fi
      firstGroup=0

      printf '    {\n'
      printf '      "id": "%s",\n' "$(json_escape "$base")"
      printf '      "type": "%s",\n' "$(json_escape "$type")"
      printf '      "paths": {\n'
      printf '        "dir": "%s",\n' "$(json_escape "$gdir")"
      printf '        "best": "%s",\n' "$(json_escape "${best:-}")"
      printf '        "donor": "%s",\n' "$(json_escape "${donor:-}")"
      printf '        "third": "%s"\n' "$(json_escape "${third:-}")"
      printf '      }\n'
      printf '    }'
    done
    printf '\n  ],\n'

    printf '  "cases": [\n'
    local firstCase=1
    local f
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      local bn expected
      bn="$(basename "$f")"
      if printf '%s' "$bn" | grep -qE 'T[0-9]{6}Z'; then expected="$CASES_ISO_Z"; else expected="$CASES_ISO_NAIVE"; fi

      if [ $firstCase -eq 0 ]; then printf ',\n'; fi
      firstCase=0

      printf '    {\n'
      printf '      "path": "%s",\n' "$(json_escape "$f")"
      printf '      "expectedDateTime": "%s",\n' "$(json_escape "$expected")"
      printf '      "expectedSource": "path_or_filename",\n'
      printf '      "shouldIgnoreSynologyVariants": true\n'
      printf '    }'
    done < <(find "$CASES_DIR" -type f | sort)

    printf '\n  ]\n'
    printf '}\n'
  } > "$manifest"

  log "Manifest written: $manifest"
}

main() {
  require_tools
  fetch_seeds
  make_base_media
  make_cases
  write_manifest

  cat <<EOF

✅ Test library created at: $ROOT

Key folders:
  - $DUP_DIR
  - $CASES_DIR
  - $BASE_DIR
  - $NOISE_DIR

EOF
}

main "$@"