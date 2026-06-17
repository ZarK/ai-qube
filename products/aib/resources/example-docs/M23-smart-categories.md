# Milestone 23 — Smart Categories, Media Classification & Advanced Query System

## Strategic Goal

Create a comprehensive classification and filtering system that automatically categorizes every photo and video across multiple dimensions, provides intelligent "smart categories" based on content analysis, and offers a powerful query builder for creating custom filters and smart albums. This milestone transforms Memex from a metadata-indexed archive into an intelligently-organized photo library that surfaces content the way users think about it.

**Success looks like:** User imports 50,000 photos → system automatically classifies them by capture mode (screenshots, panoramas, selfies, bursts), content type (receipts, documents, illustrations), source origin (Instagram saves, WhatsApp images), quality tier, and dozens of other dimensions → user browses via rich facets or creates custom smart albums like "High-quality landscape photos from 2023 without people" → all classifications update dynamically as new photos are imported.

---

## Why This Milestone Matters

Current photo management tools fail in predictable ways:

1. **Apple Photos** pioneered smart categories but they're closed-box, non-customizable, and don't expose the underlying logic
2. **Google Photos** has powerful AI but no user control, no local processing, and privacy concerns  
3. **Lightroom/Capture One** focus on professional workflows, not consumer photo chaos
4. **Every tool** treats saved images (screenshots, social media saves) as second-class citizens despite them being 30-50% of most libraries

Memex can do better by:
- Making classification logic transparent and extensible
- Treating ALL image sources as first-class (camera photos, screenshots, saves, downloads)
- Combining EXIF-derived facts with AI-detected content
- Giving users a real query language, not just preset filters
- Supporting user-defined signatures for their specific use cases

---

## Dependencies and Gates (A1/A2/A3/M31/M32)

- Depends on M12a/M12b for AI-derived labels.
- Depends on M13 or M28 for people presence dimensions.
- A1 gate: store classification results in typed columns with indexes; avoid JSON blobs for core dimensions.
- A2 gate: bulk classification refresh streams with backpressure, bounded pending map, and correlation IDs.
- A3 gate: query builder and category lists must virtualize long lists and avoid per-item layer promotion.
- M32 gate: use breadcrumb/path search/selection summary patterns (no checkbox trees) and stable `data-testid` hooks.

### Settings (M31)

Use M31 `classification.*` keys:
- `classification.enabled`
- `classification.sources.aiEnabled`
- `classification.sources.heuristicEnabled`
- `classification.minConfidence`
- `classification.maxLabelsPerAsset`
- `classification.customSignaturesEnabled`

### Stable Selectors (E2E)

- `data-testid="smart-categories-panel"`
- `data-testid="smart-category-{id}"`
- `data-testid="query-builder"`
- `data-testid="query-rule-row-{id}"`
- `data-testid="facet-toggle-{dimension}"`

E2E scenarios must remain deterministic (fixtures, stubs, no sleep-based waits, disable animations).

---

## Core Concepts

### Classification Dimensions

Every photo/video is classified across multiple orthogonal dimensions:

| Dimension | Source | Examples |
|-----------|--------|----------|
| **Media Format** | File extension, container | JPEG, HEIC, PNG, RAW, MP4, MOV |
| **Capture Mode** | EXIF, filename, dimensions | Screenshot, Panorama, Portrait, Burst, HDR, Night, Selfie |
| **Content Type** | AI (M12a) | Receipt, Document, Handwriting, Illustration, QR Code, Meme |
| **Source Origin** | Dimensions + filename patterns | Instagram, Snapchat, WhatsApp, Twitter, TikTok, Web Download |
| **Scene Type** | AI (M12a) | Indoor, Outdoor, Landscape, Cityscape, Close-up, Food |
| **Quality Tier** | AI + EXIF | Sharp, Slightly Blurry, Blurry, Overexposed, Underexposed |
| **People Presence** | M13 or M28 | No People, Solo, Couple, Small Group, Crowd |
| **Time Context** | EXIF + derived | Morning, Afternoon, Evening, Night, Golden Hour |
| **Aspect Category** | Dimensions | Portrait, Landscape, Square, Panoramic, Ultra-wide |
| **Resolution Tier** | Dimensions | SD, HD, Full HD, 4K, 8K+ |

### Classification Sources

Classifications come from three sources with different reliability:

1. **Deterministic (100% reliable)**: File extension, dimensions, EXIF fields
2. **Heuristic (high confidence)**: Filename patterns, dimension signatures, EXIF combinations
3. **AI-derived (confidence scored)**: Content analysis from M12a

### Smart Categories vs Facets vs Smart Albums

| Concept | Definition | Location | User-Editable |
|---------|------------|----------|---------------|
| **Smart Category** | System-defined classification bucket | Sidebar utilities section | No (hide only) |
| **Facet** | Filterable dimension with dynamic values | Facet bar chips | No |
| **Smart Album** | User-defined saved query | Saved Views sidebar | Yes (full control) |
| **Custom Facet Value** | User-defined value within a facet dimension | Facet dropdown | Yes |

---

## Part 1: Media Format & Capture Mode Classification

### 1.1 Media Format Hierarchy

Two-level hierarchy: Category → Format

```
Photos
├── JPEG (.jpg, .jpeg)
├── HEIC/HEIF (.heic, .heif)
├── PNG (.png)
├── WebP (.webp)
├── GIF (static) (.gif, single frame)
├── BMP (.bmp)
├── TIFF (.tiff, .tif)
└── RAW
    ├── Adobe DNG (.dng)
    ├── Canon (.cr2, .cr3)
    ├── Nikon (.nef)
    ├── Sony (.arw)
    ├── Fuji (.raf)
    ├── Olympus (.orf)
    ├── Panasonic (.rw2)
    └── Other RAW

Videos
├── MP4 (.mp4, .m4v)
├── MOV (.mov)
├── AVI (.avi)
├── MKV (.mkv)
├── WebM (.webm)
└── Other Video

Animated
├── GIF (animated) (.gif, multi-frame)
├── APNG (.apng, .png animated)
└── Live Photo (paired .heic + .mov)

Audio (if supported)
├── MP3 (.mp3)
├── AAC (.aac, .m4a)
└── WAV (.wav)
```

### 1.2 Capture Mode Detection

Capture modes are detected via EXIF, filename patterns, and dimension analysis.

#### EXIF-Based Detection

| Mode | EXIF Indicator | Notes |
|------|----------------|-------|
| **Portrait Mode** | `CustomRendered = 8` or `DepthMapPresent` or lens metadata indicating portrait lens | iPhone, Pixel, Samsung |
| **Panorama** | `CustomRendered = 6` or aspect ratio > 2.5:1 with camera EXIF | Distinguish from cropped |
| **HDR** | `CustomRendered = 4` or `HDRImageType` present | |
| **Night Mode** | `CustomRendered = 10` or exposure > 1s with recent iPhone | iPhone specific |
| **Macro** | Lens metadata or focus distance < 10cm | |
| **Burst** | `BurstUUID` present or sequential naming < 1s apart | Group detection |
| **Time-lapse** | Video with frame rate < 10fps or EXIF indicator | |
| **Slo-mo** | Video with frame rate > 60fps | 120fps, 240fps common |
| **Cinematic** | `CinematicVideoStyle` or depth video tracks | iPhone 13+ |
| **Long Exposure** | Exposure time > 1s (photo) | Live Photo long exposure different |
| **RAW** | File is RAW format | Simple extension check |
| **ProRAW** | `.dng` with Apple maker notes | iPhone specific |
| **Selfie** | `LensID` indicates front camera or EXIF front camera flag | |
| **Live Photo** | Paired HEIC + MOV with matching `ContentIdentifier` | Requires pair detection |

#### Screenshot Detection (Non-AI)

Screenshots are detected via dimension signatures and filename patterns. This is a curated, versioned database.

**Detection Algorithm:**
```
IF filename matches screenshot pattern (Screenshot*, Capture*, Screen Shot*)
  → Screenshot (high confidence)
ELSE IF dimensions exactly match known screenshot signature
  AND no camera EXIF present
  AND file created time ≈ file modified time
  → Screenshot (high confidence)
ELSE IF dimensions match screenshot signature
  AND has camera EXIF
  → NOT screenshot (it's a resized photo)
```

**Screenshot Signature Database (bundled, updatable):**

```yaml
version: "2024.01"
signatures:
  # iPhone Screenshots (logical resolution × scale factor)
  - name: "iPhone 15 Pro Max"
    dimensions: [[1290, 2796], [2796, 1290]]
    scale: 3
  - name: "iPhone 15 Pro"
    dimensions: [[1179, 2556], [2556, 1179]]
    scale: 3
  - name: "iPhone 15/15 Plus"
    dimensions: [[1170, 2532], [2532, 1170], [1284, 2778], [2778, 1284]]
    scale: 3
  - name: "iPhone 14 Pro Max"
    dimensions: [[1290, 2796], [2796, 1290]]
    scale: 3
  # ... (extensive list for all iPhone, iPad, Android, Mac, Windows)
  
  # Mac Screenshots
  - name: "MacBook Pro 16 (2021+)"
    dimensions: [[3456, 2234], [2234, 3456]]
    note: "Retina, may vary with scaling"
  - name: "iMac 24"
    dimensions: [[4480, 2520]]
  
  # Windows Screenshots (common resolutions)
  - name: "1080p"
    dimensions: [[1920, 1080], [1080, 1920]]
  - name: "1440p"
    dimensions: [[2560, 1440], [1440, 2560]]
  - name: "4K"
    dimensions: [[3840, 2160], [2160, 3840]]

filename_patterns:
  - "^Screenshot.*"
  - "^Screen Shot.*"
  - "^Capture.*"
  - "^Bildschirmfoto.*"  # German
  - "^Skjermbilde.*"     # Norwegian
  - "^スクリーンショット.*"  # Japanese
```

#### Screen Recording Detection

```
IF file is video
  AND dimensions match screenshot signature
  AND no audio track OR system audio only
  AND frame rate is 30/60fps exactly
  AND no camera EXIF
  → Screen Recording (high confidence)
```

### 1.3 Source Origin Detection (Social Media Saves)

Detect images saved from social media apps via dimension signatures and filename patterns.

**Detection Priority:**
1. Filename pattern (highest confidence)
2. Exact dimension match (high confidence)
3. Aspect ratio + dimension range (medium confidence)

**Source Signature Database (bundled + user-extensible):**

```yaml
version: "2024.01"
sources:
  instagram:
    display_name: "Instagram"
    icon: "instagram"
    signatures:
      # Posts (square, portrait, landscape)
      - dimensions: [[1080, 1080]]
        type: "post_square"
      - dimensions: [[1080, 1350]]
        type: "post_portrait"
      - dimensions: [[1080, 608]]
        type: "post_landscape"
      # Stories/Reels
      - dimensions: [[1080, 1920]]
        type: "story_reel"
      # Profile pictures
      - dimensions: [[320, 320], [150, 150]]
        type: "profile_pic"
    filename_patterns:
      - "^IMG_\\d{8}_\\d{6}_\\d+\\.jpg$"  # Instagram save pattern
      
  snapchat:
    display_name: "Snapchat"
    icon: "snapchat"
    signatures:
      - dimensions: [[1080, 1920], [720, 1280]]
        type: "snap"
      - dimensions: [[1080, 2340], [1080, 2400]]  # Full screen on newer phones
        type: "snap_fullscreen"
    filename_patterns:
      - "^Snapchat-\\d+\\.jpg$"
      
  tiktok:
    display_name: "TikTok"
    icon: "tiktok"
    signatures:
      - dimensions: [[1080, 1920]]
        type: "video_thumbnail"
      - dimensions: [[720, 1280]]
        type: "video_thumbnail_720"
    filename_patterns:
      - "^.*tiktok.*$"
      
  twitter_x:
    display_name: "Twitter/X"
    icon: "twitter"
    signatures:
      - dimensions: [[1200, 675], [1200, 1200], [1200, 1350]]
        type: "post"
      - dimensions: [[400, 400], [200, 200]]
        type: "profile_pic"
        
  whatsapp:
    display_name: "WhatsApp"
    icon: "whatsapp"
    signatures:
      - dimensions: [[1280, 720], [1920, 1080]]  # Compressed
        type: "shared_image"
    filename_patterns:
      - "^IMG-\\d{8}-WA\\d+\\.jpg$"
      
  facebook:
    display_name: "Facebook"
    icon: "facebook"
    signatures:
      - dimensions: [[960, 960], [720, 720]]
        type: "post"
      - dimensions: [[170, 170], [320, 320]]
        type: "profile_pic"
        
  telegram:
    display_name: "Telegram"
    icon: "telegram"
    filename_patterns:
      - "^photo_\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2}\\.jpg$"
      
  signal:
    display_name: "Signal"
    icon: "signal"
    filename_patterns:
      - "^signal-\\d{4}-\\d{2}-\\d{2}-\\d{6}.*$"
      
  discord:
    display_name: "Discord"
    icon: "discord"
    filename_patterns:
      - "^unknown.*$"  # Discord's default
      - "^image\\d*\\.png$"

  # Historical dimensions (apps change over time)
  kik:
    display_name: "Kik"
    icon: "kik"
    signatures:
      - dimensions: [[960, 1280], [1080, 1440]]
        type: "message"
        years: [2014, 2020]  # When these dimensions were used
```

**User-Defined Source Signatures:**

Users can define custom signatures for apps or sources not in the bundled database:

```sql
CREATE TABLE user_source_signatures (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT,
    dimensions_json TEXT,       -- [[w,h], [w,h], ...]
    filename_pattern TEXT,      -- Regex
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

---

## Part 2: AI Content Classification (M12a Extension)

### 2.1 Extended M12a Extraction Schema

Add new fields to the M12a extraction prompt and schema:

```typescript
interface ExtendedExtractionSchema {
  // ... existing M12a fields ...
  
  content_classification: {
    // Primary content type
    primary_type: 'photograph' | 'screenshot' | 'illustration' | 'document' | 'meme' | 'artwork' | 'graphic_design' | 'comic' | 'map' | 'chart' | 'ui_mockup';
    confidence: number;
    
    // Document subtypes (if document)
    document_type?: 'receipt' | 'invoice' | 'business_card' | 'id_card' | 'ticket' | 'menu' | 'form' | 'letter' | 'certificate' | 'label' | 'packaging' | 'book_page' | 'magazine_page' | 'newspaper' | 'handwritten_note' | 'whiteboard' | 'presentation_slide' | 'other_document';
    
    // Flags (can have multiple)
    has_handwriting: boolean;
    has_printed_text: boolean;
    has_qr_code: boolean;
    has_barcode: boolean;
    has_signature: boolean;
    has_stamp: boolean;
    has_logo: boolean;
    
    // Illustration subtypes (if illustration)
    illustration_style?: 'digital_art' | 'traditional_art' | 'vector' | 'pixel_art' | 'sketch' | 'cartoon' | '3d_render' | 'ai_generated' | 'infographic';
    
    // Screenshot subtypes (AI can sometimes detect even without dimension match)
    screenshot_type?: 'mobile_app' | 'desktop_app' | 'webpage' | 'game' | 'video_frame' | 'social_media' | 'messaging' | 'code_editor';
    detected_app?: string;  // "Instagram", "Safari", "VS Code", etc.
    
    // Meme detection
    is_meme: boolean;
    meme_template?: string;  // Known template name if recognized
  };
  
  quality_assessment: {
    // Existing M12a fields plus:
    technical_quality: 'excellent' | 'good' | 'acceptable' | 'poor';
    aesthetic_quality: 'excellent' | 'good' | 'acceptable' | 'poor';
    
    issues: Array<'blur' | 'noise' | 'overexposed' | 'underexposed' | 'lens_flare' | 'chromatic_aberration' | 'dust_spots' | 'red_eye' | 'motion_blur' | 'compression_artifacts' | 'banding'>;
    
    is_duplicate_likely: boolean;  // Looks like a near-duplicate of another
    is_edited: boolean;            // Signs of editing (filters, crops, overlays)
    has_watermark: boolean;
    has_border: boolean;           // Added border/frame
    has_text_overlay: boolean;     // Text added over image
  };
}
```

### 2.2 Updated AI Prompt (extends M12a)

The M12a prompt is extended with content classification instructions:

```
CONTENT CLASSIFICATION:
Determine the primary type of this image:
- "photograph": Real-world photo taken with a camera
- "screenshot": Capture of a screen (phone, computer, TV)
- "illustration": Hand-drawn or digitally created artwork
- "document": Paper document, form, receipt, etc.
- "meme": Image with text overlay intended for humor/sharing
- "artwork": Fine art, paintings, sculptures (photographed)
- "graphic_design": Logos, posters, advertisements
- "comic": Comic strips, manga, graphic novels
- "map": Geographic maps, floor plans
- "chart": Graphs, charts, diagrams
- "ui_mockup": User interface designs

If document, classify the document type.
If screenshot, identify the platform and app if recognizable.
If illustration, classify the style.

QUALITY FLAGS:
- has_watermark: Visible watermark or copyright text
- has_border: Decorative border added to image
- has_text_overlay: Text placed over the image (not part of scene)
- is_edited: Signs of filters, crops, or manipulation
```

---

## Part 3: Derived Classifications

### 3.1 People Presence

Derived from M12a `people` field and M13 face detection:

| Category | Definition |
|----------|------------|
| No People | `people.present = false` AND face_count = 0 |
| Solo | face_count = 1 |
| Couple | face_count = 2 |
| Small Group | face_count 3-6 |
| Large Group | face_count 7-15 |
| Crowd | face_count > 15 OR `people.count = "many"` |

### 3.2 Time of Day

Derived from EXIF capture time with location-aware sunrise/sunset:

| Category | Definition |
|----------|------------|
| Night | Before sunrise - 1hr OR after sunset + 1hr |
| Dawn | Sunrise ± 30min |
| Morning | Sunrise + 30min to 12:00 |
| Afternoon | 12:00 to sunset - 1hr |
| Golden Hour | Sunset ± 1hr |
| Dusk | Sunset ± 30min |

If no GPS, fall back to simple time ranges (Night: 21:00-05:00, etc.)

### 3.3 Aspect Ratio Categories

| Category | Ratio Range | Common Uses |
|----------|-------------|-------------|
| Square | 0.95 - 1.05 | Instagram, profile pics |
| Portrait (4:5) | 0.75 - 0.85 | Instagram portrait |
| Portrait (3:4) | 0.70 - 0.78 | Phone photos |
| Portrait (2:3) | 0.62 - 0.70 | DSLR portrait |
| Portrait (9:16) | 0.54 - 0.60 | Stories, TikTok |
| Landscape (4:3) | 1.28 - 1.40 | Phone landscape |
| Landscape (3:2) | 1.45 - 1.55 | DSLR landscape |
| Landscape (16:9) | 1.70 - 1.85 | Video, widescreen |
| Panoramic | 2.0 - 3.0 | Wide panoramas |
| Ultra-wide | > 3.0 | 360° or extreme pano |

### 3.4 Resolution Tiers

| Tier | Megapixels | Typical Source |
|------|------------|----------------|
| Tiny | < 0.3 MP | Thumbnails, icons |
| Small | 0.3 - 1 MP | Old phones, web images |
| SD | 1 - 2 MP | Early smartphones |
| HD | 2 - 4 MP | ~1080p equivalent |
| Full HD | 4 - 8 MP | Standard smartphone |
| 4K | 8 - 16 MP | Modern smartphone |
| High-res | 16 - 50 MP | Pro cameras |
| Ultra-high | > 50 MP | Medium format, merged |

---

## Part 4: Database Schema

### 4.1 Classification Storage

```sql
-- Core classification table (one row per asset, computed values)
CREATE TABLE asset_classification (
    asset_id TEXT PRIMARY KEY REFERENCES assets(id),
    
    -- Format classification
    format_category TEXT NOT NULL,      -- 'photo', 'video', 'animated', 'audio'
    format_type TEXT NOT NULL,          -- 'jpeg', 'heic', 'mp4', etc.
    is_raw INTEGER DEFAULT 0,
    
    -- Capture mode (from EXIF)
    capture_mode TEXT,                  -- 'screenshot', 'panorama', 'portrait', 'burst', etc.
    capture_mode_confidence REAL DEFAULT 1.0,
    is_selfie INTEGER DEFAULT 0,
    is_live_photo INTEGER DEFAULT 0,
    live_photo_pair_id TEXT,            -- Links paired HEIC + MOV
    burst_group_id TEXT,                -- Links burst sequence
    
    -- Source origin detection
    source_origin TEXT,                 -- 'instagram', 'snapchat', 'camera', etc.
    source_origin_type TEXT,            -- 'post', 'story', 'profile_pic', etc.
    source_origin_confidence REAL DEFAULT 1.0,
    is_user_defined_source INTEGER DEFAULT 0,
    
    -- AI content classification (populated by M12a)
    content_type TEXT,                  -- 'photograph', 'screenshot', 'illustration', etc.
    content_subtype TEXT,               -- 'receipt', 'digital_art', etc.
    content_confidence REAL,
    has_handwriting INTEGER DEFAULT 0,
    has_printed_text INTEGER DEFAULT 0,
    has_qr_code INTEGER DEFAULT 0,
    has_barcode INTEGER DEFAULT 0,
    is_meme INTEGER DEFAULT 0,
    is_edited INTEGER DEFAULT 0,
    has_watermark INTEGER DEFAULT 0,
    has_text_overlay INTEGER DEFAULT 0,
    
    -- Derived classifications
    people_presence TEXT,               -- 'none', 'solo', 'couple', 'small_group', 'large_group', 'crowd'
    time_of_day TEXT,                   -- 'night', 'dawn', 'morning', 'afternoon', 'golden_hour', 'dusk'
    aspect_category TEXT,               -- 'square', 'portrait_4_5', 'landscape_16_9', etc.
    resolution_tier TEXT,               -- 'tiny', 'sd', 'hd', '4k', etc.
    
    -- Quality
    quality_tier TEXT,                  -- 'excellent', 'good', 'acceptable', 'poor'
    quality_issues_json TEXT,           -- JSON array of issues
    
    -- Timestamps
    classified_at TEXT NOT NULL,
    classification_version TEXT NOT NULL,
    
    FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
);

CREATE INDEX idx_classification_format ON asset_classification(format_category, format_type);
CREATE INDEX idx_classification_capture ON asset_classification(capture_mode);
CREATE INDEX idx_classification_source ON asset_classification(source_origin);
CREATE INDEX idx_classification_content ON asset_classification(content_type, content_subtype);
CREATE INDEX idx_classification_people ON asset_classification(people_presence);
CREATE INDEX idx_classification_quality ON asset_classification(quality_tier);

-- Screenshot signatures (bundled + can be updated)
CREATE TABLE screenshot_signatures (
    id TEXT PRIMARY KEY,
    device_name TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    scale_factor REAL DEFAULT 1.0,
    os TEXT,                            -- 'ios', 'android', 'macos', 'windows'
    min_os_version TEXT,
    max_os_version TEXT,
    notes TEXT,
    is_bundled INTEGER DEFAULT 1,
    created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_screenshot_dims ON screenshot_signatures(width, height);

-- Source origin signatures (bundled + user-defined)
CREATE TABLE source_signatures (
    id TEXT PRIMARY KEY,
    source_name TEXT NOT NULL,          -- 'instagram', 'snapchat', etc.
    display_name TEXT NOT NULL,
    icon TEXT,
    width INTEGER,
    height INTEGER,
    filename_pattern TEXT,              -- Regex
    signature_type TEXT,                -- 'post', 'story', 'profile', etc.
    confidence_boost REAL DEFAULT 0,    -- Added to base confidence
    is_bundled INTEGER DEFAULT 1,
    is_user_defined INTEGER DEFAULT 0,
    active_from_year INTEGER,           -- When this signature was valid
    active_to_year INTEGER,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX idx_source_dims ON source_signatures(width, height);
CREATE INDEX idx_source_name ON source_signatures(source_name);

-- User-defined custom facet values
CREATE TABLE custom_facet_values (
    id TEXT PRIMARY KEY,
    facet_dimension TEXT NOT NULL,      -- 'source_origin', 'capture_mode', etc.
    value_name TEXT NOT NULL,
    display_name TEXT NOT NULL,
    icon TEXT,
    query_json TEXT NOT NULL,           -- LibraryQuery that defines this value
    description TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX idx_custom_facet_dimension ON custom_facet_values(facet_dimension);
```

### 4.2 Smart Album Storage

```sql
-- Smart albums (user-defined saved queries)
CREATE TABLE smart_albums (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT,
    color TEXT,
    query_json TEXT NOT NULL,           -- Full LibraryQuery
    description TEXT,
    
    -- Display options
    sort_by TEXT DEFAULT 'captured_at',
    sort_direction TEXT DEFAULT 'desc',
    layout TEXT DEFAULT 'grid',
    
    -- Sidebar options
    show_in_sidebar INTEGER DEFAULT 1,
    sidebar_sort_order INTEGER,
    
    -- Computed cache
    cached_count INTEGER,
    cache_updated_at TEXT,
    
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX idx_smart_album_sidebar ON smart_albums(show_in_sidebar, sidebar_sort_order);
```

---

## Part 5: Smart Categories (Sidebar Utilities)

### 5.1 Utilities Section Structure

The Utilities section in the sidebar provides quick access to system-defined smart categories. These are organized into logical groups:

```
UTILITIES
─────────────────
♡ Favorites                    (1,268)
⊘ Hidden                       🔒
🗑 Recently Deleted            🔒

DATA QUALITY
─────────────────
📋 Duplicates                  (1,104)
📍 Missing Location            (567)
📅 Missing Date                (234)
🔍 Not AI Analyzed             (1,892)

MEDIA TYPES
─────────────────
🎬 Videos                      (5,975)
📸 Selfies                     (2,052)
◐ Live Photos                  (20,833)
◑ Portrait Mode                (920)
▭ Panoramas                    (459)
⏱ Time-lapse                   (8)
🐌 Slo-mo                      (61)
🎞 Cinematic                   (30)
⚡ Bursts                      (82)
📱 Screenshots                 (2,243)
⏺ Screen Recordings           (160)
✨ Animated                    (850)
📷 RAW                         (77)

CONTENT TYPES
─────────────────
🧾 Receipts                    (1,104)
✍️ Handwriting                 (1,120)
🎨 Illustrations               (1,151)
◫ QR Codes                    (134)
📄 Documents                   (1,178)
😂 Memes                       (423)

SAVED FROM
─────────────────
📷 Camera Originals            (45,232)
📥 Instagram                   (2,341)
💬 WhatsApp                    (1,456)
👻 Snapchat                    (234)
🎵 TikTok                      (89)
🐦 Twitter/X                   (156)
🌐 Web Downloads               (1,234)
❓ Unknown Source              (567)

QUALITY
─────────────────
⭐ High Quality                (12,456)
😑 Blurry                      (1,234)
☀️ Overexposed                 (234)
🌑 Underexposed                (456)

🗺 Map                         → (opens map view)
📥 Imports                     → (opens import history)
```

### 5.2 Utility Item Definition

```typescript
interface UtilityItem {
  id: string;
  category: 'user_actions' | 'data_quality' | 'media_types' | 'content_types' | 'source_origin' | 'quality';
  name: string;
  icon: string;
  query: LibraryQuery;
  
  // Display options
  showCount: boolean;
  showLockIcon: boolean;        // For Hidden, Recently Deleted
  isLink: boolean;              // Opens different view (Map, Imports)
  linkTarget?: string;
  
  // Availability
  requiresEnrichment?: string[];
  minimumCount?: number;        // Hide if fewer than N items
  
  // User customization
  canHide: boolean;
  canReorder: boolean;
  defaultVisible: boolean;
  defaultSortOrder: number;
}
```

### 5.3 Utility Settings

Users can customize which utilities are visible:

```
Settings → Library → Utilities

Choose which utilities appear in the sidebar.
Drag to reorder within each category.

☑ Favorites
☑ Hidden
☑ Recently Deleted
────────────────────
DATA QUALITY
☑ Duplicates
☑ Missing Location
☐ Missing Date          (hidden by user)
☑ Not AI Analyzed
────────────────────
MEDIA TYPES
☑ Videos
☑ Selfies
...
────────────────────
[Restore Defaults]
```

---

## Part 6: Advanced Query Builder

### 6.1 Query Model Extensions

Extend the existing `LibraryQuery` to support the new classification dimensions:

```typescript
interface LibraryQuery {
  // ... existing fields from M6 ...
  
  // Format filters
  formatCategories?: Array<'photo' | 'video' | 'animated' | 'audio'>;
  formatTypes?: string[];                    // 'jpeg', 'heic', 'mp4', etc.
  isRaw?: boolean;
  
  // Capture mode filters
  captureModes?: string[];                   // 'screenshot', 'panorama', 'portrait', etc.
  isSelfie?: boolean;
  isLivePhoto?: boolean;
  isBurst?: boolean;
  
  // Source origin filters
  sourceOrigins?: string[];                  // 'instagram', 'snapchat', 'camera', etc.
  isUserDefinedSource?: boolean;
  
  // Content type filters (AI)
  contentTypes?: string[];                   // 'photograph', 'document', 'illustration', etc.
  contentSubtypes?: string[];                // 'receipt', 'digital_art', etc.
  hasHandwriting?: boolean;
  hasPrintedText?: boolean;
  hasQrCode?: boolean;
  hasBarcode?: boolean;
  isMeme?: boolean;
  isEdited?: boolean;
  hasWatermark?: boolean;
  
  // Derived filters
  peoplePresence?: string[];                 // 'none', 'solo', 'couple', etc.
  timeOfDay?: string[];                      // 'morning', 'afternoon', 'golden_hour', etc.
  aspectCategories?: string[];               // 'square', 'portrait_4_5', etc.
  resolutionTiers?: string[];                // 'sd', 'hd', '4k', etc.
  
  // Quality filters
  qualityTiers?: string[];                   // 'excellent', 'good', 'acceptable', 'poor'
  excludeQualityIssues?: string[];           // 'blur', 'overexposed', etc.
  
  // Dimension filters (custom)
  dimensions?: {
    width?: { min?: number; max?: number; exact?: number };
    height?: { min?: number; max?: number; exact?: number };
    aspectRatio?: { min?: number; max?: number };
    megapixels?: { min?: number; max?: number };
  };
  
  // Negation support
  not?: Partial<LibraryQuery>;               // Exclude items matching this sub-query
  
  // Compound queries
  or?: LibraryQuery[];                       // Match ANY of these queries
}
```

### 6.2 Query Builder UI

The query builder is accessible via:
1. Command bar (Cmd+K → "Create Smart Album" or "Advanced Search")
2. Facet bar overflow menu → "Advanced Filters"
3. Right-click on any facet chip → "Create filter from..."

**Query Builder Interface:**

```
┌─────────────────────────────────────────────────────────────────────┐
│ ✨ Create Smart Album                                    [×]       │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│ Name: [High-quality landscapes without people          ]           │
│                                                                     │
│ ─── MATCH ALL OF ─────────────────────────────────────────────────  │
│                                                                     │
│ ┌─────────────────────────────────────────────────────────────────┐│
│ │ [Scene Type    ▼] [is         ▼] [Landscape, Nature     ▼] [×] ││
│ └─────────────────────────────────────────────────────────────────┘│
│ ┌─────────────────────────────────────────────────────────────────┐│
│ │ [People       ▼] [is         ▼] [No People              ▼] [×] ││
│ └─────────────────────────────────────────────────────────────────┘│
│ ┌─────────────────────────────────────────────────────────────────┐│
│ │ [Quality      ▼] [is         ▼] [Excellent, Good        ▼] [×] ││
│ └─────────────────────────────────────────────────────────────────┘│
│ ┌─────────────────────────────────────────────────────────────────┐│
│ │ [Date         ▼] [is after   ▼] [2023-01-01            ]  [×] ││
│ └─────────────────────────────────────────────────────────────────┘│
│                                                                     │
│ [+ Add Condition]                                                   │
│                                                                     │
│ ─── EXCLUDE ──────────────────────────────────────────────────────  │
│                                                                     │
│ ┌─────────────────────────────────────────────────────────────────┐│
│ │ [Content Type ▼] [is         ▼] [Screenshot             ▼] [×] ││
│ └─────────────────────────────────────────────────────────────────┘│
│                                                                     │
│ [+ Add Exclusion]                                                   │
│                                                                     │
│ ─── PREVIEW ──────────────────────────────────────────────────────  │
│                                                                     │
│ 2,456 photos match this query                        [Preview →]   │
│                                                                     │
│ ─── OPTIONS ──────────────────────────────────────────────────────  │
│                                                                     │
│ ☑ Show in sidebar                                                  │
│ Icon: [🏞️  ▼]   Color: [● Blue  ▼]                                │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│                           [Cancel]  [Create Smart Album]            │
└─────────────────────────────────────────────────────────────────────┘
```

### 6.3 Condition Operators

| Operator | Applies To | SQL Equivalent |
|----------|------------|----------------|
| is | Single/multi-select | `= value` or `IN (values)` |
| is not | Single/multi-select | `!= value` or `NOT IN (values)` |
| is empty | Any nullable field | `IS NULL` |
| is not empty | Any nullable field | `IS NOT NULL` |
| is after | Dates | `> date` |
| is before | Dates | `< date` |
| is between | Dates, numbers | `BETWEEN a AND b` |
| contains | Text fields | `LIKE '%value%'` |
| starts with | Text fields | `LIKE 'value%'` |
| greater than | Numbers | `> value` |
| less than | Numbers | `< value` |
| matches | Dimensions | Custom dimension logic |

### 6.4 Available Filter Dimensions

| Category | Dimensions |
|----------|------------|
| **Date & Time** | Capture Date, Time of Day, Season, Day of Week, Year, Month |
| **Location** | Country, Region, City, Place Name, Has Location |
| **Camera** | Make, Model, Lens, Focal Length, Aperture, ISO, Shutter Speed |
| **Format** | Category (Photo/Video), Type (JPEG/HEIC/...), Is RAW |
| **Capture Mode** | Screenshot, Panorama, Portrait, Selfie, Live Photo, Burst, HDR, Night |
| **Source** | Origin App, Is Camera Original, Is Saved Image |
| **Content** | Primary Type, Document Type, Has Handwriting, Has QR Code, Is Meme |
| **People** | Presence Category, Specific Person, Face Count |
| **Objects** | Detected Object Classes |
| **Scene** | Indoor/Outdoor, Scene Type, Weather (if enriched) |
| **Quality** | Quality Tier, Specific Issues, Is Edited, Has Watermark |
| **Dimensions** | Width, Height, Aspect Ratio, Megapixels, Resolution Tier |
| **File** | File Size, File Name Pattern |
| **Organization** | In Album, Has Keyword, Has Event |

### 6.5 Query Text Syntax (Advanced)

For power users, support a text-based query syntax in the command bar:

```
# Simple filters
type:screenshot
source:instagram
quality:excellent

# Negation
NOT type:screenshot
-source:instagram

# Combinations
type:photo AND quality:excellent
(source:instagram OR source:tiktok) AND people:none

# Ranges
date:2023 OR date:2024
megapixels:>12
width:1080..1920

# Special filters
has:location
missing:date
is:edited
is:meme

# Complex example
type:photo AND quality:excellent AND people:none AND NOT is:screenshot AND date:2023..2024 AND has:location
```

---

## Part 7: Facet Integration

### 7.1 New Facet Chips

Add new facet chips to the facet bar (M19 integration):

| Facet | Display Type | Values |
|-------|--------------|--------|
| **Capture Mode** | Multi-select dropdown | Screenshot, Panorama, Portrait, Selfie, Live Photo, etc. |
| **Source** | Multi-select dropdown | Camera, Instagram, WhatsApp, etc. |
| **Content Type** | Multi-select chips | Photo, Screenshot, Document, Illustration, Meme |
| **People** | Multi-select chips | None, Solo, Group |
| **Quality** | Multi-select chips | Excellent, Good, Acceptable, Poor |
| **Aspect** | Multi-select chips | Square, Portrait, Landscape, Panoramic |
| **Resolution** | Range slider or chips | SD, HD, 4K, etc. |

### 7.2 Facet Registry Extension

```typescript
const EXTENDED_FACET_REGISTRY: FacetConfig[] = [
  // ... existing facets ...
  
  {
    id: 'captureMode',
    label: 'Capture Mode',
    table: 'asset_classification',
    column: 'capture_mode',
    displayType: 'dropdown',
    multiSelect: true,
    showEmpty: false,
    icon: '📸',
  },
  {
    id: 'sourceOrigin',
    label: 'Source',
    table: 'asset_classification',
    column: 'source_origin',
    displayType: 'dropdown',
    multiSelect: true,
    showEmpty: true,
    emptyLabel: 'Camera Original',
    icon: '📥',
  },
  {
    id: 'contentType',
    label: 'Content',
    table: 'asset_classification',
    column: 'content_type',
    displayType: 'chips',
    multiSelect: true,
    requiresEnrichment: ['ai_extraction'],
    icon: '🏷️',
  },
  {
    id: 'peoplePresence',
    label: 'People',
    table: 'asset_classification',
    column: 'people_presence',
    displayType: 'chips',
    multiSelect: true,
    requiresEnrichment: ['ai_extraction'],
    icon: '👥',
  },
  {
    id: 'qualityTier',
    label: 'Quality',
    table: 'asset_classification',
    column: 'quality_tier',
    displayType: 'chips',
    multiSelect: true,
    requiresEnrichment: ['ai_extraction'],
    icon: '⭐',
  },
  {
    id: 'aspectCategory',
    label: 'Aspect Ratio',
    table: 'asset_classification',
    column: 'aspect_category',
    displayType: 'dropdown',
    multiSelect: true,
    icon: '▭',
  },
  {
    id: 'resolutionTier',
    label: 'Resolution',
    table: 'asset_classification',
    column: 'resolution_tier',
    displayType: 'dropdown',
    multiSelect: true,
    icon: '📐',
  },
];
```

### 7.3 Custom Facet Values

Users can define custom values within facet dimensions:

```
Facet: Source Origin
──────────────────────────
☑ Camera
☑ Instagram
☑ WhatsApp
...
──────────────────────────
+ Add Custom Source...
```

Clicking "Add Custom Source" opens:

```
┌─────────────────────────────────────────────────────────────────┐
│ Add Custom Source                                        [×]    │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│ Name: [Kik                                              ]      │
│                                                                 │
│ Detection Method:                                               │
│ ○ Exact dimensions                                             │
│   Width: [960 ] × Height: [1280]                               │
│                                                                 │
│ ○ Filename pattern                                             │
│   Pattern: [                                            ]      │
│                                                                 │
│ ○ Both (match either)                                          │
│                                                                 │
│ Notes: [Old messaging app, used 2014-2020               ]      │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│ Preview: 234 photos would match                                 │
├─────────────────────────────────────────────────────────────────┤
│                                    [Cancel]  [Add Source]       │
└─────────────────────────────────────────────────────────────────┘
```

---

## Part 8: Classification Pipeline

### 8.1 Pipeline Steps

Classification runs as part of the import pipeline, after fingerprinting:

```
Discover → Fingerprint → Classify → Duplicate Detect → Metadata Extract → ...
```

**Classification sub-steps:**

1. **Format Classification** (instant): File extension → format category/type
2. **Dimension Classification** (instant): Width/height → aspect, resolution tier
3. **EXIF-Based Classification** (during metadata extract): Capture mode flags
4. **Signature Matching** (fast): Screenshot/source detection via dimensions
5. **AI Classification** (background, M12a): Content type, quality, people presence

### 8.2 Classification Service

```typescript
interface ClassificationService {
  // Run all non-AI classification for an asset
  classifyAsset(asset: Asset, exif?: ExifData): Promise<AssetClassification>;
  
  // Update classification after AI extraction completes
  updateFromAiExtraction(assetId: string, extraction: AiExtraction): Promise<void>;
  
  // Reclassify with updated signatures
  reclassifyAll(options: { signatureType?: 'screenshot' | 'source' }): Promise<void>;
  
  // Check if dimensions match any signature
  matchSignature(width: number, height: number): SignatureMatch | null;
}

interface SignatureMatch {
  type: 'screenshot' | 'source';
  name: string;
  confidence: number;
  details: {
    deviceName?: string;        // For screenshots
    sourceName?: string;        // For source origin
    signatureType?: string;     // 'post', 'story', etc.
  };
}
```

### 8.3 Classification Algorithm

```
FUNCTION classifyAsset(asset, exif):
  classification = new AssetClassification()
  
  // 1. Format (instant)
  classification.format_category = getFormatCategory(asset.extension)
  classification.format_type = normalizeExtension(asset.extension)
  classification.is_raw = isRawFormat(asset.extension)
  
  // 2. Dimensions (instant)
  classification.aspect_category = calculateAspectCategory(asset.width, asset.height)
  classification.resolution_tier = calculateResolutionTier(asset.width, asset.height)
  
  // 3. Screenshot detection (before EXIF, may override)
  screenshotMatch = matchScreenshotSignature(asset.width, asset.height)
  IF screenshotMatch AND NOT hasRealCameraExif(exif):
    classification.capture_mode = 'screenshot'
    classification.capture_mode_confidence = screenshotMatch.confidence
  
  // 4. Source origin detection
  sourceMatch = matchSourceSignature(asset.width, asset.height, asset.filename)
  IF sourceMatch:
    classification.source_origin = sourceMatch.name
    classification.source_origin_type = sourceMatch.type
    classification.source_origin_confidence = sourceMatch.confidence
  ELSE IF hasRealCameraExif(exif):
    classification.source_origin = 'camera'
    classification.source_origin_confidence = 1.0
  
  // 5. EXIF-based capture modes (if not screenshot)
  IF classification.capture_mode != 'screenshot' AND exif:
    classification.capture_mode = detectCaptureMode(exif)
    classification.is_selfie = isFrontCamera(exif)
    classification.is_live_photo = detectLivePhoto(asset, exif)
  
  // 6. Derived classifications
  IF exif.captured_at:
    classification.time_of_day = calculateTimeOfDay(exif.captured_at, asset.latitude, asset.longitude)
  
  RETURN classification
```

---

## Part 9: Dev Tasks

### Task 23.1: Database Schema & Migrations

- [ ] 23.1.1 Create `asset_classification` table
- [ ] 23.1.2 Create `screenshot_signatures` table with bundled data
- [ ] 23.1.3 Create `source_signatures` table with bundled data
- [ ] 23.1.4 Create `custom_facet_values` table
- [ ] 23.1.5 Create `smart_albums` table
- [ ] 23.1.6 Create indices for all classification queries
- [ ] 23.1.7 Add migration to populate classifications for existing assets

### Task 23.2: Signature Database

- [ ] 23.2.1 Compile comprehensive screenshot signature list (iOS, Android, Mac, Windows)
- [ ] 23.2.2 Compile social media source signatures (Instagram, Snapchat, WhatsApp, TikTok, Twitter, etc.)
- [ ] 23.2.3 Create versioned JSON/YAML data files
- [ ] 23.2.4 Implement signature loading and caching
- [ ] 23.2.5 Implement user-defined signature CRUD
- [ ] 23.2.6 Create signature update mechanism (check for updates)

### Task 23.3: Classification Service

- [ ] 23.3.1 Implement format classification logic
- [ ] 23.3.2 Implement dimension-based classification (aspect, resolution)
- [ ] 23.3.3 Implement screenshot signature matching
- [ ] 23.3.4 Implement source origin signature matching
- [ ] 23.3.5 Implement EXIF-based capture mode detection
- [ ] 23.3.6 Implement derived classification (time of day, etc.)
- [ ] 23.3.7 Integrate with import pipeline
- [ ] 23.3.8 Implement batch reclassification

### Task 23.4: M12a Extension (AI Classification)

- [ ] 23.4.1 Extend extraction schema with content_classification fields
- [ ] 23.4.2 Update AI prompt with content classification instructions
- [ ] 23.4.3 Implement extraction → classification sync
- [ ] 23.4.4 Add quality_assessment fields to extraction
- [ ] 23.4.5 Test with diverse image types (documents, memes, screenshots, etc.)

### Task 23.5: Utilities Sidebar Section

- [ ] 23.5.1 Design utility item registry
- [ ] 23.5.2 Implement utility section renderer
- [ ] 23.5.3 Add all media type utilities (Videos, Selfies, Panoramas, etc.)
- [ ] 23.5.4 Add all content type utilities (Receipts, Documents, etc.)
- [ ] 23.5.5 Add source origin utilities (Instagram, WhatsApp, etc.)
- [ ] 23.5.6 Add data quality utilities (Missing Location, etc.)
- [ ] 23.5.7 Add quality utilities (Blurry, Overexposed, etc.)
- [ ] 23.5.8 Implement utility visibility settings
- [ ] 23.5.9 Implement utility reordering

### Task 23.6: Query Model Extension

- [ ] 23.6.1 Extend LibraryQuery with new filter dimensions
- [ ] 23.6.2 Implement SQL translation for new filters
- [ ] 23.6.3 Add NOT/negation support to query model
- [ ] 23.6.4 Add OR support for compound queries
- [ ] 23.6.5 Implement dimension range filters
- [ ] 23.6.6 Update query URL serialization

### Task 23.7: Query Builder UI

- [ ] 23.7.1 Create query builder modal component
- [ ] 23.7.2 Implement condition row component
- [ ] 23.7.3 Implement dimension selector dropdown
- [ ] 23.7.4 Implement operator selector
- [ ] 23.7.5 Implement value selector (varies by dimension)
- [ ] 23.7.6 Implement exclusion section
- [ ] 23.7.7 Implement live preview with count
- [ ] 23.7.8 Implement save as smart album flow
- [ ] 23.7.9 Integrate with command bar

### Task 23.8: Query Text Syntax

- [ ] 23.8.1 Define query syntax grammar
- [ ] 23.8.2 Implement query parser
- [ ] 23.8.3 Implement query → SQL translation
- [ ] 23.8.4 Add syntax highlighting in command bar
- [ ] 23.8.5 Add autocomplete suggestions
- [ ] 23.8.6 Add syntax help/documentation

### Task 23.9: Facet Integration

- [ ] 23.9.1 Add Capture Mode facet
- [ ] 23.9.2 Add Source Origin facet
- [ ] 23.9.3 Add Content Type facet
- [ ] 23.9.4 Add People Presence facet
- [ ] 23.9.5 Add Quality facet
- [ ] 23.9.6 Add Aspect Ratio facet
- [ ] 23.9.7 Add Resolution facet
- [ ] 23.9.8 Implement custom facet value CRUD UI

### Task 23.10: Smart Albums

- [ ] 23.10.1 Implement smart album CRUD service
- [ ] 23.10.2 Add smart albums to sidebar
- [ ] 23.10.3 Implement smart album count caching
- [ ] 23.10.4 Implement edit smart album flow
- [ ] 23.10.5 Implement duplicate smart album
- [ ] 23.10.6 Implement delete smart album with confirmation

---

## Part 10: Acceptance Criteria

### Classification Accuracy

- [ ] Screenshots detected with >95% precision, >90% recall
- [ ] Source origins detected with >90% precision for known signatures
- [ ] Capture modes match Apple Photos classification for same images
- [ ] User-defined signatures work correctly
- [ ] Reclassification updates all affected assets

### Utilities Section

- [ ] All utility items display correct counts
- [ ] Counts update after import/delete
- [ ] Clicking utility filters library correctly
- [ ] Utility visibility settings persist
- [ ] Reordering works and persists

### Query Builder

- [ ] All filter dimensions available
- [ ] Operators work correctly for each type
- [ ] AND/OR/NOT logic works correctly
- [ ] Preview count matches actual results
- [ ] Saved smart albums restore correctly

### Facets

- [ ] New facets appear when data exists
- [ ] Facets hidden when no data
- [ ] Multi-select works correctly
- [ ] Custom facet values work correctly
- [ ] Counts update with other filters

### Performance

- [ ] Classification <50ms per asset (non-AI)
- [ ] Signature matching <1ms per check
- [ ] Utility counts <100ms total
- [ ] Query builder preview <200ms
- [ ] Smart album count cache refresh <500ms

---

## Part 11: E2E Test Scenarios

### Test 1: `screenshot_detection_accurate`
Import fixture with known screenshots (iOS, Android, Mac, Windows) and non-screenshots with same dimensions (resized photos). Assert screenshots correctly classified. Assert resized photos NOT classified as screenshots.

### Test 2: `source_origin_detection`
Import fixture with known Instagram, WhatsApp, Snapchat saves. Assert source origin correctly detected. Assert camera photos classified as "camera".

### Test 3: `capture_mode_from_exif`
Import fixture with portrait mode, panorama, HDR, selfie images. Assert capture modes correctly detected from EXIF.

### Test 4: `utilities_show_correct_counts`
Import varied fixture. Assert each utility shows correct count. Delete some items. Assert counts update.

### Test 5: `query_builder_creates_smart_album`
Open query builder. Add conditions for landscape + excellent quality + no people. Save as smart album. Assert album appears in sidebar. Assert clicking it shows correct results.

### Test 6: `custom_source_signature`
Add custom source signature for "Kik" with specific dimensions. Import fixture with matching images. Assert images classified as Kik.

### Test 7: `facet_filters_combine_correctly`
Select "Screenshot" in capture mode facet. Select "Instagram" in source facet. Assert results show Instagram screenshots (if any) or empty state.

### Test 8: `query_text_syntax_works`
Type `type:photo AND quality:excellent AND NOT is:screenshot` in command bar. Assert results match expected.

### Test 9: `ai_content_classification_syncs`
Run AI extraction on fixture with receipts, documents, memes. Assert content_type classifications populated. Assert utilities show correct counts.

### Test 10: `user_defined_facet_value`
Create custom facet value "Work Screenshots" = screenshots from 2024 with specific dimension. Assert facet shows custom value. Assert filtering works.

---

## Part 12: Stable Selectors

| Selector | Element |
|----------|---------|
| `utilities-section` | Utilities sidebar section |
| `utility-item-{id}` | Individual utility row |
| `utility-count-{id}` | Utility count badge |
| `facet-chip-captureMode` | Capture mode facet chip |
| `facet-chip-sourceOrigin` | Source origin facet chip |
| `facet-chip-contentType` | Content type facet chip |
| `facet-chip-quality` | Quality facet chip |
| `query-builder-modal` | Query builder modal |
| `query-builder-add-condition` | Add condition button |
| `query-builder-condition-{n}` | Nth condition row |
| `query-builder-dimension-select` | Dimension dropdown |
| `query-builder-operator-select` | Operator dropdown |
| `query-builder-value-select` | Value selector |
| `query-builder-preview-count` | Preview count display |
| `query-builder-save` | Save smart album button |
| `smart-album-{id}` | Smart album sidebar item |
| `custom-facet-add` | Add custom facet value button |
| `custom-source-modal` | Custom source signature modal |

---

## Part 13: Dependencies

| Milestone | Relationship |
|-----------|--------------|
| M1 (Import) | Classification runs during import pipeline |
| M5 (Metadata) | EXIF data needed for capture mode detection |
| M6 (Search/Facets) | Query model foundation, facet infrastructure |
| M12a (AI Keywords) | AI content classification extends M12a |
| M13 (Faces) | People presence uses face count |
| M19 (Dynamic Facets) | New facets use M19 infrastructure |
| M20 (Auto Views) | Utilities section alongside browse-by |

---

## Part 14: Future Considerations

### Not in Scope for M23

1. **Activity tracking** (Recently Viewed/Edited/Shared) - requires usage logging infrastructure
2. **Duplicate merge from utilities** - M3 handles this
3. **Hidden/Recently Deleted management** - separate user data management milestone
4. **Lens-based filtering** - deferred per your input, can add later
5. **Season detection** - can derive from date + hemisphere, low priority

### Potential Extensions

1. **Signature crowdsourcing**: Allow users to submit new signatures for inclusion in bundled database
2. **ML-based signature detection**: Train model to detect app of origin from visual patterns
3. **Query templates**: Pre-built query templates for common use cases
4. **Smart album sharing**: Export/import smart album definitions

### Apple Native Types: Classification vs Import Handling

M23 provides **classification** for Apple native media types via EXIF/dimension analysis. However, some types require **import-time pairing** to create unified virtual_media items. This pairing is handled by separate issues, not M23:

| Type | M23 Classification | Import Pairing Issue |
|------|-------------------|---------------------|
| **Live Photos** | `is_live_photo`, `live_photo_pair_id` | #558 - Paired HEIC+MOV import |
| **Bursts** | `capture_mode='burst'`, `burst_group_id` | #559 - Grouped by BurstUUID |
| **RAW+JPEG pairs** | `is_raw` | #560 - Paired RAW+processed import |
| **Selfies** | `is_selfie` via CameraType | None needed (single file) |
| **Portrait Mode** | `capture_mode='portrait'` | None needed (depth embedded) |
| **Panoramas** | CustomRendered=6 or aspect | None needed (single file) |
| **Time-lapse** | Video fps < 10 | None needed (single file) |
| **Slo-mo** | Video fps > 60 | None needed (single file) |
| **Cinematic** | CinematicVideoStyle | None needed (depth embedded) |
| **Long Exposure** | Exposure > 1s | None needed (single file) |
| **HDR** | HDRHeadroom marker | None needed (gain map embedded) |
| **Night Mode** | EXIF markers | None needed (single file) |
| **Screenshots** | Dimension signatures | None needed (single file) |
| **Screen Recordings** | Video + screenshot dims | None needed (single file) |

### Apple Native Types NOT Covered

The following Apple-specific media types are **not currently supported** by M23:

1. **Spatial Photos/Videos** (Apple Vision Pro)
   - Format: MV-HEVC with stereoscopic left/right eye views
   - Detection: Requires checking for spatial video tracks or MV-HEVC codec
   - EXIF markers: `SpatialAudioFormat`, stereoscopic metadata
   - Impact: Rare currently, but will grow as Vision Pro adoption increases
   - Recommendation: Add detection in future milestone when spatial content becomes common

2. **ProRes Video** (iPhone 13 Pro+)
   - Format: ProRes 422 HQ in .MOV container
   - Detection: Codec identification (already possible via ffprobe)
   - Note: Not a separate "type" per se, but a quality tier for video
