#!/usr/bin/env python3
"""
Generate test fixtures for PhotoMeta single-file handling:
- best datetime selection across sources (EXIF/XMP/Takeout/path/filesystem/GPS)
- scan/import detection signals (software/model/path)
- filename cleanup: strip bloat and keep core tokens when present
- GUID/garbage fallback -> canonical datetime name
- Apple IMG counter collision risk -> date-prefixed policy

Creates: tests/fixtures/<case>/{input,expected}/...
"""

from __future__ import annotations
import json
import os
import re
from dataclasses import dataclass, asdict
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any, Dict, Optional, List

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests" / "fixtures"

# -------------------------
# Helpers
# -------------------------

def write_text(p: Path, s: str) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(s, encoding="utf-8")

def write_bytes(p: Path, b: bytes) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b)

def iso(dt: datetime) -> str:
    # stable ISO for expected output
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")

def month_name(dt: datetime) -> str:
    return dt.strftime("%B")  # January, February...

def bloated_name(dt: datetime, dims: str, tail: str) -> str:
    # Example: 2013-December-25_16-00-00.777_3264x2448_IMG_0618
    return f"{dt.year}-{month_name(dt)}-{dt.day:02d}_{dt.hour:02d}-{dt.minute:02d}-{dt.second:02d}.{int(dt.microsecond/1000):03d}_{dims}_{tail}"

def looks_like_guid(s: str) -> bool:
    return bool(re.fullmatch(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", s))

def canonical_datetime_name(dt: datetime, ms: Optional[int] = None) -> str:
    # yyyyMMdd_HHmmss[_fff]
    base = dt.strftime("%Y%m%d_%H%M%S")
    if ms is not None:
        return f"{base}_{ms:03d}"
    return base

# -------------------------
# Case model
# -------------------------

@dataclass
class Expected:
    # Filename policy expectations
    expected_base_name: str               # without extension
    expected_extension: str
    # Datetime resolution expectations
    expected_capture_time_iso: Optional[str]  # UTC ISO string or None
    expected_time_precision: str              # DateOnly | DateAndTime | Unknown
    expected_source_type: str                 # GpsTimestamp | EmbeddedExif | XmpSidecar | GoogleTakeoutJson | FilenameParsed | PathParsed | FilesystemTimestamp | None
    expected_flags: Dict[str, bool]           # IsLikelyImportTimestamp, IsScanLike, IsDefaultTime, etc.

@dataclass
class FixtureCase:
    name: str
    description: str
    rel_input_path: str  # relative path under input/ (includes folders)
    exiftool_tags: Dict[str, Any]
    make_xmp: bool
    xmp_tags: Dict[str, str]
    make_takeout_json: bool
    takeout_payload: Dict[str, Any]
    expected: Expected

# -------------------------
# Synthetic metadata templates
# -------------------------

def exiftool_obj(source_rel_path: str, tags: Dict[str, Any]) -> Dict[str, Any]:
    obj = {"SourceFile": source_rel_path}
    obj.update(tags)
    return obj

def xmp_sidecar_xml(tags: Dict[str, str]) -> str:
    # minimal XMP RDF (enough for XmpSidecarParser)
    # tags keys should be like: "xmp:CreateDate", "exif:GPSLatitude"
    # We'll map prefixes to namespaces expected in your parser.
    ns = {
        "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
        "xmp": "http://ns.adobe.com/xap/1.0/",
        "exif": "http://ns.adobe.com/exif/1.0/",
        "photoshop": "http://ns.adobe.com/photoshop/1.0/",
    }

    def xmlns_attrs() -> str:
        return " ".join([f'xmlns:{k}="{v}"' for k, v in ns.items()])

    # put most tags as attributes on rdf:Description (parser checks both attr and elem)
    attrs = []
    elems = []
    for k, v in tags.items():
        if ":" not in k:
            continue
        prefix, local = k.split(":", 1)
        if prefix not in ns:
            continue
        # keep CreateDate/DateTimeOriginal as attributes for simplicity
        if local in ("CreateDate", "DateTimeOriginal", "ModifyDate", "DateCreated", "GPSLatitude", "GPSLongitude"):
            attrs.append(f'{prefix}:{local}="{v}"')
        else:
            elems.append(f"<{prefix}:{local}>{v}</{prefix}:{local}>")

    return f"""<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF {xmlns_attrs()}>
    <rdf:Description {' '.join(attrs)}>
      {''.join(elems)}
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
"""

# -------------------------
# Cases
# -------------------------

def build_cases() -> List[FixtureCase]:
    cases: List[FixtureCase] = []

    # 1) EXIF beats filesystem import time in Takeout path; name keeps DSC_####
    dt_exif = datetime(2019, 7, 7, 23, 27, 51)
    dt_fs = datetime(2024, 1, 1, 10, 0, 0)  # import much later
    cases.append(FixtureCase(
        name="exif_beats_filesystem_import_takeout",
        description="Embedded EXIF capture time should win over filesystem time in Takeout/import paths. Keep DSC token.",
        rel_input_path="Takeout/Google Photos/2019/DSC_5777.jpg",
        exiftool_tags={
            "ExifIFD:DateTimeOriginal": "2019:07:07 23:27:51",
            "System:FileModifyDate": dt_fs.strftime("%Y:%m:%d %H:%M:%S"),
            "IFD0:Model": "Canon PowerShot S80",
            "IFD0:Make": "Canon",
            "IFD0:Software": "Google Photos",
            "File:ImageWidth": 3264,
            "File:ImageHeight": 2448,
        },
        make_xmp=False,
        xmp_tags={},
        make_takeout_json=False,
        takeout_payload={},
        expected=Expected(
            expected_base_name="DSC_5777",
            expected_extension=".jpg",
            expected_capture_time_iso=iso(dt_exif.replace(tzinfo=timezone.utc)),
            expected_time_precision="DateAndTime",
            expected_source_type="EmbeddedExif",
            expected_flags={"IsLikelyImportTimestamp": True, "IsScanLike": False},
        )
    ))

    # 2) GPS timestamp wins; name from datetime-prefix + IMG token to avoid iPhone counter collisions
    dt_gps_utc = datetime(2014, 9, 26, 19, 30, 52, tzinfo=timezone.utc)  # GPS UTC
    cases.append(FixtureCase(
        name="gps_wins_iphone_img_counter_date_prefix",
        description="GPS timestamp should win. iPhone IMG counter should be date-prefixed to avoid collisions.",
        rel_input_path="Camera Roll/2014/2014-September-26_21-30-52.000_3264x2448_IMG_0444_Apple-iPhone_5.JPG",
        exiftool_tags={
            # EXIF local-ish
            "ExifIFD:DateTimeOriginal": "2014:09:26 21:30:52",
            # GPS date/time (exiftool often provides these)
            "GPS:GPSDateStamp": "2014:09:26",
            "GPS:GPSTimeStamp": "19:30:52",
            "Composite:GPSPosition": "59 deg 54' 50.04\" N, 10 deg 44' 45.00\" E",
            "IFD0:Make": "Apple",
            "IFD0:Model": "iPhone 5",
            "File:ImageWidth": 3264,
            "File:ImageHeight": 2448,
        },
        make_xmp=False,
        xmp_tags={},
        make_takeout_json=False,
        takeout_payload={},
        expected=Expected(
            expected_base_name="20140926_IMG_0444",
            expected_extension=".JPG",
            expected_capture_time_iso=iso(dt_gps_utc),
            expected_time_precision="DateAndTime",
            expected_source_type="GpsTimestamp",
            expected_flags={"IsLikelyImportTimestamp": False, "IsScanLike": False},
        )
    ))

    # 3) Takeout JSON provides photoTakenTime and geo; GUID name -> datetime canonical
    dt_takeout = datetime(2013, 12, 30, 10, 34, 43, tzinfo=timezone.utc)
    guid = "b7f1c6e0-2a7f-4c1e-a9c4-0d9cf2d0a1a2"
    cases.append(FixtureCase(
        name="guid_name_takeout_time_to_canonical_datetime",
        description="GUID base name should be replaced with canonical datetime. Takeout photoTakenTime provides capture time.",
        rel_input_path=f"Takeout/Photos/2013/{guid}.jpg",
        exiftool_tags={
            "System:FileModifyDate": "2019:01:01 00:00:00",
            "IFD0:Software": "Google Photos",
            "File:ImageWidth": 2048,
            "File:ImageHeight": 1536,
        },
        make_xmp=False,
        xmp_tags={},
        make_takeout_json=True,
        takeout_payload={
            "photoTakenTime": {"timestamp": str(int(dt_takeout.timestamp()))},
            "geoData": {"latitude": 61.2, "longitude": 7.1},
        },
        expected=Expected(
            expected_base_name=canonical_datetime_name(dt_takeout, None),
            expected_extension=".jpg",
            expected_capture_time_iso=iso(dt_takeout),
            expected_time_precision="DateAndTime",
            expected_source_type="GoogleTakeoutJson",
            expected_flags={"IsLikelyImportTimestamp": True, "IsScanLike": False},
        )
    ))

    # 4) Filename already contains Lumix-style datetime -> keep it
    dt_lumix = datetime(2012, 8, 26, 1, 7, 46)
    cases.append(FixtureCase(
        name="lumix_filename_datetime_kept",
        description="If filename is already a strong datetime token (YYYYMMDD_HHMMSS), keep it.",
        rel_input_path="DCIM/100_PANA/20120826_010746.jpg",
        exiftool_tags={
            # no embedded date -> force filename parser to matter
            "System:FileModifyDate": "2012:08:26 01:07:50",
            "IFD0:Make": "Panasonic",
            "IFD0:Model": "DMC-LX5",
            "File:ImageWidth": 4000,
            "File:ImageHeight": 3000,
        },
        make_xmp=False,
        xmp_tags={},
        make_takeout_json=False,
        takeout_payload={},
        expected=Expected(
            expected_base_name="20120826_010746",
            expected_extension=".jpg",
            expected_capture_time_iso=iso(dt_lumix.replace(tzinfo=timezone.utc)),
            expected_time_precision="DateAndTime",
            expected_source_type="FilenameParsed",
            expected_flags={"IsLikelyImportTimestamp": False, "IsScanLike": False},
        )
    ))

    # 5) Bloat name retains IMG token, strips geo/dims/camera; EXIF time used
    dt_img = datetime(2013, 12, 25, 16, 0, 0, 777000)
    cases.append(FixtureCase(
        name="bloat_name_strips_to_img_token",
        description="Bloated names should collapse to core token when present (IMG_0618).",
        rel_input_path=f"OldExports/{bloated_name(dt_img, '3264x2448', 'IMG_0618')}.jpg",
        exiftool_tags={
            "ExifIFD:DateTimeOriginal": "2013:12:25 16:00:00",
            "IFD0:Make": "Apple",
            "IFD0:Model": "iPhone 4",
            "XMP:History": "spam spam spam",
            "File:ImageWidth": 3264,
            "File:ImageHeight": 2448,
        },
        make_xmp=True,
        xmp_tags={
            "xmp:ModifyDate": "2019-01-01T00:00:00+01:00",
        },
        make_takeout_json=False,
        takeout_payload={},
        expected=Expected(
            expected_base_name="20131225_IMG_0618",
            expected_extension=".jpg",
            expected_capture_time_iso=iso(datetime(2013, 12, 25, 16, 0, 0, tzinfo=timezone.utc)),
            expected_time_precision="DateAndTime",
            expected_source_type="EmbeddedExif",
            expected_flags={"IsLikelyImportTimestamp": False, "IsScanLike": False},
        )
    ))

    # 6) Overwritten everything -> canonical datetime from merged (use EXIF)
    dt_over = datetime(2013, 12, 30, 10, 34, 43, 970000)
    overwritten = "2013-December-30_10-34-43.970_2048x2048_Geo-Norge-Sogn+og+Fjordane-6798_2013-12-30_11.35.05"
    cases.append(FixtureCase(
        name="overwritten_everything_falls_back_to_datetime",
        description="If core token missing after cleanup, normalize to canonical datetime derived from merged capture time.",
        rel_input_path=f"GeoExports/{overwritten}.jpg",
        exiftool_tags={
            "ExifIFD:DateTimeOriginal": "2013:12:30 10:34:43",
            "File:ImageWidth": 2048,
            "File:ImageHeight": 2048,
        },
        make_xmp=False,
        xmp_tags={},
        make_takeout_json=False,
        takeout_payload={},
        expected=Expected(
            expected_base_name=canonical_datetime_name(dt_over.replace(tzinfo=timezone.utc), 970),
            expected_extension=".jpg",
            expected_capture_time_iso=iso(datetime(2013, 12, 30, 10, 34, 43, tzinfo=timezone.utc)),
            expected_time_precision="DateAndTime",
            expected_source_type="EmbeddedExif",
            expected_flags={"IsLikelyImportTimestamp": False, "IsScanLike": False},
        )
    ))

    # 7) Scan-like: prefer album token; scan software/model signals
    dt_scan = datetime(2013, 6, 29, 20, 22, 36)
    cases.append(FixtureCase(
        name="scan_like_prefers_album_token",
        description="Scans should prefer stable album/token naming over scan-time. Scan signals via Software/Model.",
        rel_input_path=f"Scanner/Album1/{bloated_name(dt_scan, '1776x1076', 'album_0054_Canon-MG8200_series')}.jpg",
        exiftool_tags={
            "ExifIFD:DateTimeOriginal": "2013:06:29 20:22:36",
            "IFD0:Make": "Canon",
            "IFD0:Model": "MG8200 series",
            "IFD0:Software": "VueScan",
            "File:ImageWidth": 1776,
            "File:ImageHeight": 1076,
        },
        make_xmp=False,
        xmp_tags={},
        make_takeout_json=False,
        takeout_payload={},
        expected=Expected(
            expected_base_name="album_0054",
            expected_extension=".jpg",
            expected_capture_time_iso=iso(dt_scan.replace(tzinfo=timezone.utc)),
            expected_time_precision="DateAndTime",
            expected_source_type="EmbeddedExif",
            expected_flags={"IsLikelyImportTimestamp": False, "IsScanLike": True},
        )
    ))

    # 8) DateOnly source (WhatsApp) should stay DateOnly when higher-tier; avoid filesystem import
    dt_wa = datetime(2016, 1, 2, 0, 0, 0)
    cases.append(FixtureCase(
        name="whatsapp_dateonly_preserved",
        description="WhatsApp VID-YYYYMMDD-WA0001 yields DateOnly precision. Should not be replaced by filesystem import time.",
        rel_input_path="WhatsApp/VID-20160102-WA0001.mp4",
        exiftool_tags={
            "System:FileModifyDate": "2020:01:01 12:00:00",
            "QuickTime:CreateDate": "0000:00:00 00:00:00",  # bad default should be rejected by parser
        },
        make_xmp=False,
        xmp_tags={},
        make_takeout_json=False,
        takeout_payload={},
        expected=Expected(
            expected_base_name="20160102_VID-WA0001",  # policy: prefix date to avoid collisions, keep WA token
            expected_extension=".mp4",
            expected_capture_time_iso=iso(dt_wa.replace(tzinfo=timezone.utc)),
            expected_time_precision="DateOnly",
            expected_source_type="FilenameParsed",
            expected_flags={"IsLikelyImportTimestamp": True, "IsScanLike": False},
        )
    ))

    return cases

# -------------------------
# Materialize fixtures
# -------------------------

def make_placeholder_media(ext: str) -> bytes:
    # tiny bytes; tests should not rely on real decoding
    if ext.lower() in [".jpg", ".jpeg", ".jpe", ".png", ".heic"]:
        return b"\xff\xd8\xff" + b"PHOTOMETA_TEST" + b"\xff\xd9"
    if ext.lower() in [".mp4", ".mov", ".m4v"]:
        return b"\x00\x00\x00\x18ftypmp42" + b"PHOTOMETA_TEST"
    return b"PHOTOMETA_TEST"

def generate() -> None:
    cases = build_cases()
    FIXTURES.mkdir(parents=True, exist_ok=True)

    index = []
    for c in cases:
        case_dir = FIXTURES / c.name
        inp = case_dir / "input"
        exp = case_dir / "expected"

        # create media file
        rel = Path(c.rel_input_path)
        media_path = inp / rel
        ext = media_path.suffix
        write_bytes(media_path, make_placeholder_media(ext))

        # exiftool JSON fixture
        exif_path = case_dir / "exiftool.json"
        exif_json = [exiftool_obj(str(rel).replace("\\", "/"), c.exiftool_tags)]
        write_text(exif_path, json.dumps(exif_json, indent=2))

        # XMP sidecar, if requested
        if c.make_xmp:
            xmp_path = media_path.with_suffix(".xmp")
            write_text(xmp_path, xmp_sidecar_xml(c.xmp_tags))

        # Google Takeout JSON sidecar, if requested
        if c.make_takeout_json:
            takeout_path = Path(str(media_path) + ".json")
            write_text(takeout_path, json.dumps(c.takeout_payload, indent=2))

        # expected output spec (what the test should assert)
        write_text(exp / "case.json", json.dumps({
            "name": c.name,
            "description": c.description,
            "input_rel_path": c.rel_input_path,
            "expected": asdict(c.expected),
        }, indent=2))

        index.append({
            "name": c.name,
            "description": c.description,
            "input_rel_path": c.rel_input_path,
        })

    write_text(FIXTURES / "index.json", json.dumps(index, indent=2))
    write_text(FIXTURES / "README.md",
               "# PhotoMeta Fixtures\n\n"
               "Generated by tools/generate_fixtures.py\n\n"
               "Each case has:\n"
               "- input/ (media + sidecars)\n"
               "- exiftool.json (synthetic exiftool output)\n"
               "- expected/case.json (assertions)\n")

    print(f"Generated {len(cases)} cases under: {FIXTURES}")

if __name__ == "__main__":
    generate()