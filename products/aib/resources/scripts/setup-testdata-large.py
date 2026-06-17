#!/usr/bin/env python3
"""
Memex Large Test Dataset Setup Script

Downloads real photos from open datasets for comprehensive testing of:
- M5: Metadata Merge (EXIF, dates, camera info)
- M7: Places (GPS coordinates for reverse geocoding)
- M8: Weather (GPS + dates for historical weather)
- M9: Map View (geotagged photos)
- M10: Color Extraction (varied photo content)
- M11: Event Detection (photos with dates)
- M12: AI Keywords (object detection training data)
- M13: Face Recognition (face datasets)
- M14: Object Recognition (COCO, Open Images)

Sources:
- ianare/exif-samples: Real EXIF preserved, GPS samples
- drewnoakes/metadata-extractor-images: 400+ camera samples with EXIF
- FiftyOne zoo: COCO, LFW, Open Images subsets
- LFW: Labeled Faces in the Wild

Usage:
    # Install dependencies first:
    pip install fiftyone requests tqdm

    # Run the script:
    python scripts/setup-testdata-large.py

    # Or run specific datasets:
    python scripts/setup-testdata-large.py --only exif,lfw

Requirements:
    - Python 3.10+
    - ~5GB disk space for full dataset
    - Internet connection
    - exiftool (for verification)
    - czkawka_cli (for duplicate detection)
"""

import os
import sys
import json
import shutil
import hashlib
import argparse
import tempfile
import zipfile
import subprocess
from pathlib import Path
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed

# Try to import optional dependencies
try:
    import requests
    HAS_REQUESTS = True
except ImportError:
    HAS_REQUESTS = False

try:
    from tqdm import tqdm
    HAS_TQDM = True
except ImportError:
    HAS_TQDM = False

try:
    import fiftyone as fo
    import fiftyone.zoo as foz
    HAS_FIFTYONE = True
except ImportError:
    HAS_FIFTYONE = False


# Configuration
SCRIPT_DIR = Path(__file__).parent.resolve()
PROJECT_ROOT = SCRIPT_DIR.parent
FIXTURE_DIR = PROJECT_ROOT / "e2e" / "fixtures" / "large-testset"
PHOTOS_DIR = FIXTURE_DIR / "photos"

# Dataset sources
DATASETS = {
    "exif-samples": {
        "url": "https://github.com/ianare/exif-samples/archive/refs/heads/master.zip",
        "description": "EXIF test samples with GPS data",
        "extract_pattern": "*.jpg",
    },
    "metadata-extractor": {
        "url": "https://github.com/drewnoakes/metadata-extractor-images/archive/refs/heads/master.zip",
        "description": "400+ camera samples with full EXIF metadata",
        "extract_pattern": "*/jpg/*.jpg",
    },
}


def print_header(text: str) -> None:
    """Print a formatted header."""
    print(f"\n{'=' * 60}")
    print(f"  {text}")
    print(f"{'=' * 60}\n")


def print_step(text: str) -> None:
    """Print a step indicator."""
    print(f"  → {text}")


def check_dependencies() -> list[str]:
    """Check for required dependencies."""
    missing = []
    
    if not HAS_REQUESTS:
        missing.append("requests")
    
    # Check for exiftool
    try:
        subprocess.run(["exiftool", "-ver"], capture_output=True, check=True)
    except (subprocess.CalledProcessError, FileNotFoundError):
        missing.append("exiftool (brew install exiftool)")
    
    # Check for czkawka
    try:
        subprocess.run(["czkawka_cli", "--version"], capture_output=True, check=True)
    except (subprocess.CalledProcessError, FileNotFoundError):
        missing.append("czkawka_cli (brew install czkawka)")
    
    return missing


def setup_directories() -> None:
    """Create fixture directories."""
    if FIXTURE_DIR.exists():
        print_step(f"Removing existing {FIXTURE_DIR.name}/")
        shutil.rmtree(FIXTURE_DIR)
    
    PHOTOS_DIR.mkdir(parents=True, exist_ok=True)
    print_step(f"Created {PHOTOS_DIR}")


def download_file(url: str, dest: Path, desc: str = None) -> bool:
    """Download a file with progress indicator."""
    if not HAS_REQUESTS:
        print("  ERROR: requests library not installed")
        return False
    
    try:
        response = requests.get(url, stream=True, timeout=300)
        response.raise_for_status()
        
        total_size = int(response.headers.get('content-length', 0))
        
        with open(dest, 'wb') as f:
            if HAS_TQDM and total_size > 0:
                with tqdm(total=total_size, unit='B', unit_scale=True, desc=desc) as pbar:
                    for chunk in response.iter_content(chunk_size=8192):
                        f.write(chunk)
                        pbar.update(len(chunk))
            else:
                downloaded = 0
                for chunk in response.iter_content(chunk_size=8192):
                    f.write(chunk)
                    downloaded += len(chunk)
                    if total_size > 0:
                        pct = (downloaded / total_size) * 100
                        print(f"\r  Downloading: {pct:.1f}%", end="", flush=True)
                print()
        
        return True
    except Exception as e:
        print(f"  ERROR downloading: {e}")
        return False


def download_exif_samples() -> int:
    """Download ianare/exif-samples repository."""
    print_header("Downloading ianare/exif-samples")
    
    url = DATASETS["exif-samples"]["url"]
    
    with tempfile.TemporaryDirectory() as tmpdir:
        zip_path = Path(tmpdir) / "exif-samples.zip"
        
        if not download_file(url, zip_path, "exif-samples.zip"):
            return 0
        
        print_step("Extracting JPG files...")
        count = 0
        
        with zipfile.ZipFile(zip_path, 'r') as zf:
            for name in zf.namelist():
                if name.lower().endswith(('.jpg', '.jpeg')):
                    try:
                        data = zf.read(name)
                        # Get parent folder + filename for unique naming
                        parts = Path(name).parts
                        if len(parts) >= 2:
                            prefix = parts[-2]
                        else:
                            prefix = "exif"
                        filename = Path(name).name
                        # Sanitize filename
                        safe_name = "".join(c if c.isalnum() or c in '._-' else '_' for c in filename)
                        dest = PHOTOS_DIR / f"{prefix}_{safe_name}"
                        dest.write_bytes(data)
                        count += 1
                    except Exception as e:
                        pass  # Skip problematic files
        
        print_step(f"Extracted {count} images")
        return count


def download_metadata_extractor() -> int:
    """Download drewnoakes/metadata-extractor-images repository."""
    print_header("Downloading drewnoakes/metadata-extractor-images")
    
    url = DATASETS["metadata-extractor"]["url"]
    
    with tempfile.TemporaryDirectory() as tmpdir:
        zip_path = Path(tmpdir) / "metadata-extractor.zip"
        
        if not download_file(url, zip_path, "metadata-extractor.zip"):
            return 0
        
        print_step("Extracting JPG files from /jpg/ folder...")
        count = 0
        
        with zipfile.ZipFile(zip_path, 'r') as zf:
            for name in zf.namelist():
                # Only extract from jpg folder
                if '/jpg/' in name.lower() and name.lower().endswith(('.jpg', '.jpeg')):
                    try:
                        data = zf.read(name)
                        filename = Path(name).name
                        # Sanitize filename (handle spaces and parentheses)
                        safe_name = "".join(c if c.isalnum() or c in '._-' else '_' for c in filename)
                        dest = PHOTOS_DIR / f"meta_{safe_name}"
                        dest.write_bytes(data)
                        count += 1
                    except Exception as e:
                        pass  # Skip problematic files
        
        print_step(f"Extracted {count} images")
        return count


def download_lfw_sample(max_images: int = 200) -> int:
    """Download LFW face samples via FiftyOne."""
    print_header(f"Downloading LFW Face Samples ({max_images} images)")
    
    if not HAS_FIFTYONE:
        print_step("FiftyOne not installed, skipping LFW")
        print_step("Install with: pip install fiftyone")
        return 0
    
    try:
        # Load LFW test split (smaller)
        print_step("Loading LFW dataset via FiftyOne...")
        dataset = foz.load_zoo_dataset(
            "lfw",
            split="test",
            max_samples=max_images,
        )
        
        count = 0
        for sample in dataset:
            if sample.filepath and os.path.exists(sample.filepath):
                ext = Path(sample.filepath).suffix
                dest = PHOTOS_DIR / f"lfw_{count:04d}{ext}"
                shutil.copy2(sample.filepath, dest)
                count += 1
        
        print_step(f"Copied {count} LFW face images")
        return count
        
    except Exception as e:
        print_step(f"Error loading LFW: {e}")
        return 0


def download_coco_sample(max_images: int = 300) -> int:
    """Download COCO object detection samples via FiftyOne."""
    print_header(f"Downloading COCO Samples ({max_images} images)")
    
    if not HAS_FIFTYONE:
        print_step("FiftyOne not installed, skipping COCO")
        print_step("Install with: pip install fiftyone")
        return 0
    
    try:
        print_step("Loading COCO-2017 validation split via FiftyOne...")
        dataset = foz.load_zoo_dataset(
            "coco-2017",
            split="validation",
            max_samples=max_images,
        )
        
        count = 0
        for sample in dataset:
            if sample.filepath and os.path.exists(sample.filepath):
                ext = Path(sample.filepath).suffix
                dest = PHOTOS_DIR / f"coco_{count:04d}{ext}"
                shutil.copy2(sample.filepath, dest)
                count += 1
        
        print_step(f"Copied {count} COCO images")
        return count
        
    except Exception as e:
        print_step(f"Error loading COCO: {e}")
        return 0


def run_czkawka_duplicates() -> dict:
    """Run czkawka to find duplicate images."""
    print_header("Running Czkawka Duplicate Detection")
    
    duplicates_json = FIXTURE_DIR / "duplicates.json"
    
    try:
        result = subprocess.run(
            ["czkawka_cli", "dup", "-d", str(PHOTOS_DIR), "-p", str(duplicates_json)],
            capture_output=True,
            text=True,
            timeout=300,
        )
        
        if duplicates_json.exists():
            with open(duplicates_json) as f:
                data = json.load(f)
            
            # Count duplicate groups (czkawka v10 format: keys are file sizes)
            groups = [g for g in data.values() if isinstance(g, list)]
            total_duplicates = sum(len(group[0]) if group else 0 for group in groups)
            
            print_step(f"Found {len(groups)} duplicate groups ({total_duplicates} files)")
            return {"groups": len(groups), "files": total_duplicates}
        else:
            print_step("No duplicates.json created (no duplicates found)")
            return {"groups": 0, "files": 0}
            
    except subprocess.TimeoutExpired:
        print_step("Czkawka timed out")
        return {"groups": 0, "files": 0, "error": "timeout"}
    except FileNotFoundError:
        print_step("czkawka_cli not found")
        return {"groups": 0, "files": 0, "error": "not_found"}
    except Exception as e:
        print_step(f"Error running czkawka: {e}")
        return {"groups": 0, "files": 0, "error": str(e)}


def verify_exif_data() -> dict:
    """Verify EXIF data quality using exiftool."""
    print_header("Verifying EXIF Data Quality")
    
    photos = list(PHOTOS_DIR.glob("*.jpg")) + list(PHOTOS_DIR.glob("*.jpeg"))
    
    if not photos:
        return {"total": 0, "with_gps": 0, "with_date": 0, "with_camera": 0}
    
    stats = {
        "total": len(photos),
        "with_gps": 0,
        "with_date": 0,
        "with_camera": 0,
        "with_faces": 0,  # LFW images
        "coco_objects": 0,  # COCO images
    }
    
    try:
        # Use exiftool's -if filtering which handles large file counts better
        # Count photos with GPS
        result = subprocess.run(
            ["exiftool", "-if", "$GPSLatitude", "-p", "$filename", str(PHOTOS_DIR)],
            capture_output=True, text=True, timeout=120,
        )
        if result.returncode == 0:
            stats["with_gps"] = len([l for l in result.stdout.strip().split("\n") if l])
        
        # Count photos with DateTimeOriginal
        result = subprocess.run(
            ["exiftool", "-if", "$DateTimeOriginal", "-p", "$filename", str(PHOTOS_DIR)],
            capture_output=True, text=True, timeout=120,
        )
        if result.returncode == 0:
            stats["with_date"] = len([l for l in result.stdout.strip().split("\n") if l])
        
        # Count photos with Camera Make
        result = subprocess.run(
            ["exiftool", "-if", "$Make", "-p", "$filename", str(PHOTOS_DIR)],
            capture_output=True, text=True, timeout=120,
        )
        if result.returncode == 0:
            stats["with_camera"] = len([l for l in result.stdout.strip().split("\n") if l])
        
        # Count LFW images (face dataset)
        stats["with_faces"] = len(list(PHOTOS_DIR.glob("lfw_*.jpg")))
        
        # Count COCO images (object dataset)
        stats["coco_objects"] = len(list(PHOTOS_DIR.glob("coco_*.jpg")))
        
    except Exception as e:
        print_step(f"Error running exiftool: {e}")
    
    print_step(f"Total photos: {stats['total']}")
    print_step(f"With GPS: {stats['with_gps']}")
    print_step(f"With Date: {stats['with_date']}")
    print_step(f"With Camera: {stats['with_camera']}")
    print_step(f"Face images (LFW): {stats['with_faces']}")
    print_step(f"COCO images: {stats['coco_objects']}")
    
    return stats


def create_manifest(stats: dict, duplicates: dict) -> None:
    """Create manifest.json with dataset info."""
    manifest = {
        "name": "large-testset",
        "description": "Large-scale test photos from open datasets for Memex QA",
        "created": datetime.now().isoformat(),
        "script": "scripts/setup-testdata-large.py",
        "sources": [
            {
                "name": "ianare/exif-samples",
                "url": "https://github.com/ianare/exif-samples",
                "license": "Various (test samples)",
            },
            {
                "name": "drewnoakes/metadata-extractor-images",
                "url": "https://github.com/drewnoakes/metadata-extractor-images",
                "license": "Apache 2.0",
            },
            {
                "name": "LFW (Labeled Faces in the Wild)",
                "url": "http://vis-www.cs.umass.edu/lfw/",
                "license": "Research use",
            },
            {
                "name": "COCO 2017",
                "url": "https://cocodataset.org",
                "license": "CC BY 4.0",
            },
        ],
        "stats": stats,
        "duplicates": duplicates,
        "usage": {
            "M5_metadata_merge": "All photos have varied EXIF metadata",
            "M7_places": f"{stats.get('with_gps', 0)} photos with GPS coordinates",
            "M8_weather": f"{stats.get('with_gps', 0)} GPS + {stats.get('with_date', 0)} dated photos",
            "M9_map": f"{stats.get('with_gps', 0)} geotagged photos",
            "M10_color": "All photos for color extraction",
            "M11_events": f"{stats.get('with_date', 0)} photos with dates",
            "M13_faces": f"{stats.get('with_faces', 0)} LFW face images",
            "M14_objects": "COCO images with object annotations",
        },
    }
    
    manifest_path = FIXTURE_DIR / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2))
    print_step(f"Created {manifest_path.name}")


def main():
    parser = argparse.ArgumentParser(description="Download Memex test datasets")
    parser.add_argument(
        "--only",
        help="Comma-separated list of datasets to download (exif,metadata,lfw,coco)",
        default=None,
    )
    parser.add_argument(
        "--skip-verify",
        action="store_true",
        help="Skip EXIF verification step",
    )
    parser.add_argument(
        "--skip-duplicates",
        action="store_true",
        help="Skip czkawka duplicate detection",
    )
    args = parser.parse_args()
    
    print_header("Memex Large Test Dataset Setup")
    
    # Check dependencies
    missing = check_dependencies()
    if missing:
        print("Missing dependencies:")
        for dep in missing:
            print(f"  - {dep}")
        print("\nInstall missing dependencies and try again.")
        if "requests" in str(missing):
            print("  pip install requests tqdm")
        sys.exit(1)
    
    # Parse --only filter
    only = None
    if args.only:
        only = set(args.only.lower().split(","))
    
    # Setup directories
    setup_directories()
    
    # Download datasets
    total = 0
    
    if only is None or "exif" in only:
        total += download_exif_samples()
    
    if only is None or "metadata" in only:
        total += download_metadata_extractor()
    
    if only is None or "lfw" in only:
        total += download_lfw_sample(max_images=200)
    
    if only is None or "coco" in only:
        total += download_coco_sample(max_images=300)
    
    # Run czkawka for duplicates
    duplicates = {"groups": 0, "files": 0}
    if not args.skip_duplicates:
        duplicates = run_czkawka_duplicates()
    
    # Verify EXIF data
    stats = {"total": total}
    if not args.skip_verify:
        stats = verify_exif_data()
    
    # Create manifest
    create_manifest(stats, duplicates)
    
    # Summary
    print_header("SETUP COMPLETE")
    print(f"  Total photos: {stats.get('total', total)}")
    print(f"  Location: {PHOTOS_DIR}")
    print(f"  Manifest: {FIXTURE_DIR / 'manifest.json'}")
    
    if stats.get('total', total) < 500:
        print("\n  WARNING: Less than 500 photos downloaded.")
        print("  Install fiftyone for more datasets: pip install fiftyone")
    
    return 0


if __name__ == "__main__":
    sys.exit(main())
