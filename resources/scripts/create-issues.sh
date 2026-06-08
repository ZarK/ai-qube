#!/bin/bash
# Create all 50 prioritized developer tasks as GitHub issues

set -e

# Priority 1: Foundation (1-10) - P1/P2-High, S-Ready or S-Blocking

gh issue create --title "Create Memex.Contracts project for shared DTOs" \
  --body "Define typed request/response schemas for all JSON-RPC methods. Generate TypeScript types for frontend. Version contracts for breaking changes.

**Acceptance Criteria:**
- [ ] Create src/Memex.Contracts project
- [ ] Define DTOs for all existing JSON-RPC methods
- [ ] Add versioning strategy documentation
- [ ] Generate/maintain TypeScript type definitions" \
  --label "P1-Critical,S-Blocking,C-Backend"

gh issue create --title "Add ChangeRecord table and audit logging" \
  --body "Implement audit trail for merge decisions and user overrides.

**Acceptance Criteria:**
- [ ] Create migration 0004_change_record.sql
- [ ] Add ChangeRecordRepository with insert/query
- [ ] Log merge decisions, canonical selections
- [ ] Enable user override tracking" \
  --label "P1-Critical,S-Ready,C-Database"

gh issue create --title "Implement Job/JobStep persistence to SQLite" \
  --body "Persist job state for resume capability.

**Acceptance Criteria:**
- [ ] Create job and job_step tables
- [ ] Persist job state across restarts
- [ ] Track per-asset checkpoint progress
- [ ] Enable job resume from checkpoint" \
  --label "P1-Critical,S-Blocking,C-Database"

gh issue create --title "Wire backend events to frontend via IPC" \
  --body "Forward job.progress and index events through memex:event channel.

**Acceptance Criteria:**
- [ ] Forward job.progress events to renderer
- [ ] Forward index.media.upserted events
- [ ] Update TanStack Query cache on events
- [ ] Show real-time progress in Tasks page" \
  --label "P1-Critical,S-Ready,C-Electron"

gh issue create --title "Implement virtualized grid in Library component" \
  --body "Add @tanstack/react-virtual for 10k+ items at 60fps.

**Acceptance Criteria:**
- [ ] Install and configure @tanstack/react-virtual
- [ ] Virtualize Library grid for windowed rendering
- [ ] Maintain scroll position on filter changes
- [ ] Verify 60fps with 10k items" \
  --label "P1-Critical,S-Ready,C-Frontend"

gh issue create --title "Add debounced search/filter input" \
  --body "Implement 300ms debounce on search text for performance.

**Acceptance Criteria:**
- [ ] 300ms debounce on search input
- [ ] Show loading state during filter
- [ ] Optimize query invalidation strategy" \
  --label "P2-High,S-Ready,C-Frontend"

gh issue create --title "Set up Playwright E2E test harness" \
  --body "Configure Playwright for Electron testing with existing dialog stubs.

**Acceptance Criteria:**
- [ ] Configure Playwright for Electron
- [ ] Create smoke test (launch → verify load)
- [ ] Integrate with existing test mode stubs
- [ ] Add CI workflow for E2E tests" \
  --label "P1-Critical,S-Blocking,C-Testing"

gh issue create --title "Add Jest tests for React components" \
  --body "Test Import wizard flow and Library grid rendering.

**Acceptance Criteria:**
- [ ] Set up Jest + React Testing Library
- [ ] Test Import wizard state transitions
- [ ] Test Library grid rendering
- [ ] Test Tasks page job display" \
  --label "P2-High,S-Ready,C-Testing"

gh issue create --title "Implement fingerprint step (file hashing)" \
  --body "Add xxHash64 for content deduplication.

**Acceptance Criteria:**
- [ ] Implement file hashing with xxHash64
- [ ] Store hash in Asset.FileHash column
- [ ] Stream progress events during hashing
- [ ] Add unit tests for hashing logic" \
  --label "P1-Critical,S-Ready,C-Pipeline"

gh issue create --title "Implement exiftool batch runner" \
  --body "Use -stay_open True mode for 100x performance improvement.

**Acceptance Criteria:**
- [ ] Create ExiftoolRunner service
- [ ] Implement -stay_open True mode
- [ ] Parse JSON responses incrementally
- [ ] Handle corrupt metadata gracefully" \
  --label "P1-Critical,S-Blocking,C-Pipeline"

# Priority 2: Pipeline Completion (11-20)

gh issue create --title "Add XMP sidecar parser" \
  --body "Parse .xmp files alongside images for metadata.

**Acceptance Criteria:**
- [ ] Parse .xmp sidecar files
- [ ] Extract datetime, GPS, keywords
- [ ] Create MetadataCandidate with source=xmp
- [ ] Add unit tests" \
  --label "P2-High,S-Ready,C-Pipeline"

gh issue create --title "Add Google Takeout JSON parser" \
  --body "Parse -metadata.json sidecar files from Takeout exports.

**Acceptance Criteria:**
- [ ] Parse -metadata.json files
- [ ] Extract original timestamp, GPS, description
- [ ] Handle Takeout-specific date formats
- [ ] Add unit tests with fixtures" \
  --label "P2-High,S-Ready,C-Pipeline"

gh issue create --title "Implement ffmpeg video thumbnail extraction" \
  --body "Extract keyframes for video thumbnails.

**Acceptance Criteria:**
- [ ] Create FfmpegRunner service
- [ ] Extract keyframe at configurable position
- [ ] Store as JPEG in cache directory
- [ ] Handle various video formats" \
  --label "P2-High,S-Ready,C-Pipeline"

gh issue create --title "Add video metadata extraction" \
  --body "Parse duration, resolution, codec via ffprobe.

**Acceptance Criteria:**
- [ ] Extract duration, resolution, codec
- [ ] Store in Asset record
- [ ] Include in content scoring
- [ ] Add bitrate to scoring algorithm" \
  --label "P2-High,S-Ready,C-Pipeline"

gh issue create --title "Implement blur hash computation" \
  --body "Generate BlurHash placeholders during thumbnailing.

**Acceptance Criteria:**
- [ ] Compute BlurHash for each thumbnail
- [ ] Store in ThumbCache.BlurHash column
- [ ] Serve as placeholder while loading
- [ ] Verify visual quality" \
  --label "P2-High,S-Ready,C-Pipeline"

gh issue create --title "Implement dominant color extraction" \
  --body "Calculate dominant color from thumbnails for UI placeholders.

**Acceptance Criteria:**
- [ ] Extract dominant color from thumbnail
- [ ] Store as hex in VirtualMedia.DominantColor
- [ ] Display as background in grid cards
- [ ] Optimize for performance" \
  --label "P2-High,S-Ready,C-Pipeline"

gh issue create --title "Add similar image detection via czkawka" \
  --body "Run czkawka_cli similar in addition to exact duplicates.

**Acceptance Criteria:**
- [ ] Run czkawka_cli similar command
- [ ] Parse similarity output with percentage
- [ ] Create groups with GroupKind=similar
- [ ] Configure similarity threshold" \
  --label "P2-High,S-Ready,C-Pipeline"

gh issue create --title "Implement streaming czkawka output parsing" \
  --body "Read stdout incrementally to avoid OOM on large libraries.

**Acceptance Criteria:**
- [ ] Stream parse czkawka output
- [ ] Emit progress events per group parsed
- [ ] Handle very large outputs without OOM
- [ ] Add memory benchmarks" \
  --label "P2-High,S-Ready,C-Pipeline"

gh issue create --title "Implement checkpoint/resume for imports" \
  --body "Track last processed asset per step for resume capability.

Depends on: Job/JobStep persistence

**Acceptance Criteria:**
- [ ] Track last processed asset per step
- [ ] Resume from checkpoint on restart
- [ ] Add --resume flag to CLI
- [ ] Test resume after interruption" \
  --label "P2-High,S-Blocked,C-Pipeline"

gh issue create --title "Implement proper CancellationToken propagation" \
  --body "Pass cancellation through all pipeline steps.

**Acceptance Criteria:**
- [ ] Pass CancellationToken through all steps
- [ ] Check cancellation at safe points
- [ ] Clean up partial state on cancel
- [ ] Test cancellation behavior" \
  --label "P2-High,S-Ready,C-Pipeline"

# Priority 3: Pipeline Robustness (21-30)

gh issue create --title "Add per-step status tracking in Asset" \
  --body "Track processing status per asset for incremental processing.

**Acceptance Criteria:**
- [ ] Add columns: fingerprinted_at, metadata_extracted_at, etc.
- [ ] Skip already-processed assets on rerun
- [ ] Enable selective step reruns
- [ ] Migration for new columns" \
  --label "P2-High,S-Ready,C-Database"

gh issue create --title "Implement metadata merge audit trail" \
  --body "Record per-field donor source in ChangeRecord.

Depends on: ChangeRecord table

**Acceptance Criteria:**
- [ ] Record per-field donor source
- [ ] Store conflict resolution decisions
- [ ] Enable UI provenance display
- [ ] Add query methods for audit data" \
  --label "P2-High,S-Blocked,C-Backend"

gh issue create --title "Add import profiles (Safe/Standard/Aggressive)" \
  --body "Define profile presets for import configuration.

**Acceptance Criteria:**
- [ ] Define Safe, Standard, Aggressive presets
- [ ] Map profiles to module toggles
- [ ] Persist selected profile in job parameters
- [ ] Add UI profile selector" \
  --label "P3-Medium,S-Ready,C-Backend"

gh issue create --title "Implement idempotent pipeline operations" \
  --body "Handle duplicate runs gracefully with upsert logic.

**Acceptance Criteria:**
- [ ] Use upsert instead of insert where appropriate
- [ ] Clear stale data before rerun
- [ ] Verify same results on repeated runs
- [ ] Add idempotency tests" \
  --label "P2-High,S-Ready,C-Pipeline"

gh issue create --title "Add error retry mechanism" \
  --body "Track retriable vs fatal errors with exponential backoff.

**Acceptance Criteria:**
- [ ] Classify errors as retriable vs fatal
- [ ] Implement exponential backoff
- [ ] Surface retry status in Tasks UI
- [ ] Configure max retry attempts" \
  --label "P3-Medium,S-Ready,C-Pipeline"

gh issue create --title "Implement incremental import (new files only)" \
  --body "Detect and process only new files for faster re-imports.

**Acceptance Criteria:**
- [ ] Detect new files by path not in Asset table
- [ ] Optionally check file modification time
- [ ] Skip unchanged files
- [ ] Report skipped file counts" \
  --label "P2-High,S-Ready,C-Pipeline"

gh issue create --title "Add parallel processing with bounded concurrency" \
  --body "Use Channel<T> for work distribution with configurable parallelism.

**Acceptance Criteria:**
- [ ] Implement Channel<T> work distribution
- [ ] Default to conservative parallelism (4)
- [ ] Add --max-parallelism CLI flag
- [ ] Verify NAS-friendly disk access" \
  --label "P2-High,S-Ready,C-Pipeline"

gh issue create --title "Implement progress ETA calculation" \
  --body "Track throughput and calculate remaining time estimate.

**Acceptance Criteria:**
- [ ] Track throughput (files/second)
- [ ] Calculate remaining time estimate
- [ ] Include ETA in job.progress events
- [ ] Display ETA in Tasks UI" \
  --label "P3-Medium,S-Ready,C-Pipeline"

gh issue create --title "Add dry-run support to import" \
  --body "Preview what would happen without database writes.

**Acceptance Criteria:**
- [ ] Add --dry-run flag to CLI
- [ ] Show what would happen without writes
- [ ] Report counts and potential issues
- [ ] Support dry-run in UI" \
  --label "P3-Medium,S-Ready,C-Pipeline"

gh issue create --title "Implement facet indexing step" \
  --body "Compute time buckets and counts for fast filter queries.

**Acceptance Criteria:**
- [ ] Compute time buckets (year/month/day)
- [ ] Count by camera model
- [ ] Geographic clustering for map
- [ ] Enable fast facet queries" \
  --label "P2-High,S-Ready,C-Pipeline"

# Priority 4: UI Features (31-40)

gh issue create --title "Implement Inspector panel Details tab" \
  --body "Show merged metadata with confidence indicators.

**Acceptance Criteria:**
- [ ] Display merged metadata (date, location, camera)
- [ ] Show canonical filename and proposed name
- [ ] Display confidence indicators
- [ ] Show warnings for estimated data" \
  --label "P2-High,S-Ready,C-Frontend"

gh issue create --title "Implement Inspector Duplicates tab" \
  --body "List group members with scores and canonical selection.

**Acceptance Criteria:**
- [ ] List all files in duplicate group
- [ ] Show per-file score breakdown
- [ ] Add 'Make canonical' button
- [ ] Highlight current canonical" \
  --label "P2-High,S-Ready,C-Frontend"

gh issue create --title "Implement Inspector Metadata Donors tab" \
  --body "Show per-field source attribution and manual override.

Depends on: Metadata merge audit trail

**Acceptance Criteria:**
- [ ] Show per-field source attribution
- [ ] Display conflict resolution decisions
- [ ] Enable manual override per field
- [ ] Log overrides to ChangeRecord" \
  --label "P2-High,S-Blocked,C-Frontend"

gh issue create --title "Implement Map view with clustering" \
  --body "Add map visualization for geo-tagged media.

**Acceptance Criteria:**
- [ ] Integrate Leaflet or Mapbox
- [ ] Cluster photos by location
- [ ] Support lasso/region selection
- [ ] Link to filter on selection" \
  --label "P3-Medium,S-Ready,C-Frontend"

gh issue create --title "Implement Timeline view" \
  --body "Chronological layout with event grouping.

**Acceptance Criteria:**
- [ ] Vertical chronological layout
- [ ] Group by event/day with representative images
- [ ] Collapsible sections
- [ ] Integrate with event detection" \
  --label "P3-Medium,S-Ready,C-Frontend"

gh issue create --title "Implement Calendar heatmap view" \
  --body "Year/month visualization with photo counts.

**Acceptance Criteria:**
- [ ] Year/month view with day cells
- [ ] Color by photo count
- [ ] Click to filter to specific day
- [ ] Show count tooltips" \
  --label "P3-Medium,S-Ready,C-Frontend"

gh issue create --title "Implement Table view" \
  --body "Spreadsheet-style metadata display with sorting.

**Acceptance Criteria:**
- [ ] Spreadsheet-style layout
- [ ] Sortable columns (date, size, camera)
- [ ] Multi-select for batch operations
- [ ] Column visibility toggle" \
  --label "P3-Medium,S-Ready,C-Frontend"

gh issue create --title "Implement Saved Searches" \
  --body "Save and restore filter + view configurations.

**Acceptance Criteria:**
- [ ] Save current filter + view config
- [ ] List saved views in sidebar
- [ ] Load/rename/delete saved views
- [ ] Persist to database" \
  --label "P3-Medium,S-Ready,C-Frontend"

gh issue create --title "Add filter sidebar with facets" \
  --body "Add faceted filtering for date, camera, location, type.

**Acceptance Criteria:**
- [ ] Date range picker
- [ ] Camera model selector
- [ ] Location selector
- [ ] File type checkboxes" \
  --label "P2-High,S-Ready,C-Frontend"

gh issue create --title "Implement keyboard navigation" \
  --body "Add keyboard shortcuts for grid navigation.

**Acceptance Criteria:**
- [ ] Arrow keys to navigate grid
- [ ] Enter to open detail view
- [ ] Escape to close modals
- [ ] Add keyboard shortcut hints" \
  --label "P3-Medium,S-Ready,C-Frontend"

# Priority 5: Enrichments & Testing (41-50)

gh issue create --title "Implement reverse geocoding (offline)" \
  --body "Convert GPS coordinates to location names using offline database.

**Acceptance Criteria:**
- [ ] Bundle or download offline reverse geocode DB
- [ ] Convert GPS to city/country names
- [ ] Store in VirtualMedia metadata
- [ ] Fallback for missing data" \
  --label "P3-Medium,S-Ready,C-Pipeline"

gh issue create --title "Add face detection infrastructure" \
  --body "Create schema and interface for future face detection.

**Acceptance Criteria:**
- [ ] Define face embedding table schema
- [ ] Create FaceDetectionService interface
- [ ] Add migration for face tables
- [ ] Document integration points" \
  --label "P4-Low,S-Ready,C-Backend"

gh issue create --title "Add object detection infrastructure" \
  --body "Create schema and interface for future object detection.

**Acceptance Criteria:**
- [ ] Define object tag table schema
- [ ] Create ObjectDetectionService interface
- [ ] Add migration for object tables
- [ ] Document integration points" \
  --label "P4-Low,S-Ready,C-Backend"

gh issue create --title "Implement event detection clustering" \
  --body "Cluster photos by time/location proximity.

**Acceptance Criteria:**
- [ ] Cluster by datetime proximity
- [ ] Consider GPS distance optionally
- [ ] Create event groups
- [ ] Generate suggested event names" \
  --label "P3-Medium,S-Ready,C-Pipeline"

gh issue create --title "Add AI keyword extraction placeholder" \
  --body "Create interface for future AI keyword extraction.

**Acceptance Criteria:**
- [ ] Define keyword source type 'ai'
- [ ] Create AIKeywordService interface
- [ ] Document model requirements
- [ ] Add configuration options" \
  --label "P4-Low,S-Ready,C-Backend"

gh issue create --title "Expand E2E tests for import flow" \
  --body "Test full import flow with dialog stubs.

Depends on: Playwright E2E test harness

**Acceptance Criteria:**
- [ ] Test folder selection with stubs
- [ ] Verify import completion
- [ ] Check library shows imported items
- [ ] Test error handling" \
  --label "P2-High,S-Blocked,C-Testing"

gh issue create --title "Add visual regression tests" \
  --body "Snapshot key layouts for regression detection.

Depends on: Playwright E2E test harness

**Acceptance Criteria:**
- [ ] Snapshot Library grid layout
- [ ] Snapshot Import wizard steps
- [ ] Run on CI for each PR
- [ ] Document update process" \
  --label "P3-Medium,S-Blocked,C-Testing"

gh issue create --title "Add integration test with media fixtures" \
  --body "Full pipeline test with sample media files.

**Acceptance Criteria:**
- [ ] Create small test media in tests/fixtures/media/
- [ ] Run full import pipeline
- [ ] Verify database state matches expectations
- [ ] Include various file formats" \
  --label "P2-High,S-Ready,C-Testing"

gh issue create --title "Set up multi-platform CI" \
  --body "Run tests on Ubuntu, macOS, and Windows.

**Acceptance Criteria:**
- [ ] Backend tests on Ubuntu
- [ ] E2E tests on macOS
- [ ] E2E tests on Windows
- [ ] Generate coverage reports" \
  --label "P2-High,S-Ready,C-Testing"

gh issue create --title "Add coverage reporting" \
  --body "Generate and track test coverage in CI.

**Acceptance Criteria:**
- [ ] Generate coverage reports in CI
- [ ] Set up coverage thresholds
- [ ] Display coverage badge
- [ ] Track coverage trends" \
  --label "P3-Medium,S-Ready,C-Testing"

echo "Created all 50 issues!"
