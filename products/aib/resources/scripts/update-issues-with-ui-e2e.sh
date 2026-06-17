#!/bin/bash
# Update all issues with UI and E2E test requirements

set -e

# Function to append UI and E2E sections to an issue
update_issue() {
  local number="$1"
  local ui_section="$2"
  local e2e_section="$3"
  
  # Get current body
  current_body=$(gh issue view "$number" --json body --jq '.body')
  
  # Build new body with UI and E2E sections
  new_body="$current_body

---

## UI Requirements

$ui_section

## E2E Test Requirements

$e2e_section"

  # Update the issue
  gh issue edit "$number" --body "$new_body"
  echo "Updated issue #$number"
}

# Issue #1: Create Memex.Contracts project for shared DTOs
update_issue 1 \
"- No direct UI changes required (backend infrastructure)
- Contracts will be consumed by frontend via TypeScript type definitions
- Ensure generated types are used in all IPC calls from React components" \
"**E2E Test:** Verify IPC communication works end-to-end
- [ ] Import flow completes successfully with typed IPC calls
- [ ] Query responses match expected TypeScript types
- [ ] Error responses are properly typed and displayed in UI"

# Issue #3: Implement Job/JobStep persistence to SQLite
update_issue 3 \
"**Tasks Center UI (spec 5.5):**
- [ ] Display job list with status indicators in Tasks page
- [ ] Show step-by-step progress within each job (Discover ✅, Fingerprint 🔄, etc.)
- [ ] Display job parameters summary
- [ ] Show completion statistics in job report" \
"**E2E Test:** Job persistence and resume via UI
- [ ] Start import, cancel mid-way, verify job shows as 'Cancelled' in Tasks
- [ ] Resume cancelled job, verify it continues from checkpoint
- [ ] Verify completed jobs show summary report with stats
- [ ] Test job list updates in real-time as steps complete"

# Issue #6: Add debounced search/filter input
update_issue 6 \
"**Library Search UI (spec 5.3):**
- [ ] Search input in top bar with debounced filtering
- [ ] Show loading indicator during search
- [ ] Display result count after filtering
- [ ] Clear search button to reset filter" \
"**E2E Test:** Search interaction
- [ ] Type in search box, verify results filter after debounce delay
- [ ] Verify grid updates to show only matching items
- [ ] Clear search, verify all items return
- [ ] Test search across different views (grid, table, timeline)"

# Issue #7: Set up Playwright E2E test harness
update_issue 7 \
"- E2E harness tests the entire UI flow
- DialogService stub must return test fixture paths
- All UI interactions should be automatable via selectors" \
"**E2E Test:** Harness self-validation
- [ ] App launches in test mode with MEMEX_TEST env var
- [ ] Folder picker stub returns fixture path without showing dialog
- [ ] Import completes and items appear in library grid
- [ ] All major UI elements have testable selectors (data-testid)"

# Issue #8: Add Jest tests for React components  
update_issue 8 \
"- Test all UI components with React Testing Library
- Cover import wizard steps, library grid, inspector tabs
- Mock IPC calls for unit tests" \
"**Component Tests (not E2E but related):**
- [ ] Import wizard step navigation
- [ ] Filter sidebar checkbox interactions
- [ ] Inspector tab switching
- [ ] MediaCard click and selection behavior"

# Issue #10: Implement exiftool batch runner
update_issue 10 \
"**Inspector Details Tab (spec 5.4):**
- [ ] Display extracted metadata in Details tab (date, camera, dimensions, GPS)
- [ ] Show metadata source indicators (e.g., 'from EXIF')
- [ ] Display confidence/warning for estimated values" \
"**E2E Test:** Metadata display in UI
- [ ] Import fixture with EXIF data, open Inspector Details tab
- [ ] Verify date/time, camera model, dimensions are displayed
- [ ] Verify GPS coordinates shown (if present in fixture)
- [ ] Test with file missing EXIF - verify graceful handling"

# Issue #11: Add XMP sidecar parser
update_issue 11 \
"**Inspector Metadata Donors Tab (spec 5.4):**
- [ ] Show XMP as a metadata source in donors list
- [ ] Display which fields came from XMP vs EXIF
- [ ] Allow user to prefer XMP value over EXIF if conflict" \
"**E2E Test:** XMP metadata in UI
- [ ] Import fixture with XMP sidecar, verify metadata appears
- [ ] Open Metadata Donors tab, verify XMP listed as source
- [ ] If XMP and EXIF conflict, verify donor selection UI works"

# Issue #12: Add Google Takeout JSON parser
update_issue 12 \
"**Inspector Metadata Donors Tab (spec 5.4):**
- [ ] Show 'Takeout JSON' as a metadata source
- [ ] Display Takeout-specific fields (description, title, geo)
- [ ] Indicate when Takeout provided the winning value" \
"**E2E Test:** Takeout metadata in UI
- [ ] Import fixture with Takeout JSON sidecars
- [ ] Verify dates from JSON appear in Inspector
- [ ] Open Metadata Donors tab, verify 'Takeout' source shown"

# Issue #14: Add video metadata extraction
update_issue 14 \
"**Library and Inspector (spec 5.3, 5.4):**
- [ ] Display video duration in grid overlay or hover
- [ ] Show resolution, codec, bitrate in Inspector Details
- [ ] Video icon indicator on thumbnails" \
"**E2E Test:** Video handling in UI
- [ ] Import video fixtures, verify they appear with video icon
- [ ] Open video in Inspector, verify duration and resolution shown
- [ ] Verify video doesn't auto-play in grid (only in detail view)"

# Issue #15: Implement blur hash computation
update_issue 15 \
"**Library Grid (spec 5.3):**
- [ ] Show blur placeholder immediately before thumbnail loads
- [ ] Smooth transition from blur to actual thumbnail
- [ ] Blur should match dominant colors of image" \
"**E2E Test:** Placeholder rendering
- [ ] Scroll quickly through library, verify blur placeholders appear
- [ ] Verify no blank/white squares during scroll
- [ ] Test that thumbnails eventually replace placeholders"

# Issue #16: Implement dominant color extraction
update_issue 16 \
"**Library Grid (spec 5.3):**
- [ ] Use dominant color as fallback before blur hash
- [ ] Apply as background color for loading thumbnails
- [ ] Available as a filter facet (Colors)" \
"**E2E Test:** Color placeholders and filtering
- [ ] Verify colored placeholders appear during thumbnail load
- [ ] Filter by color facet, verify relevant images shown
- [ ] Test color display in Inspector Details"

# Issue #17: Add similar image detection via czkawka
update_issue 17 \
"**Inspector Duplicates Tab (spec 5.4):**
- [ ] List similar images (not just exact duplicates)
- [ ] Show similarity percentage for each match
- [ ] Allow user to select different canonical from similars" \
"**E2E Test:** Similar image UI
- [ ] Import fixtures with similar (not identical) images
- [ ] Open Inspector Duplicates tab, verify similar images listed
- [ ] Verify similarity score displayed
- [ ] Test 'Make canonical' button on a similar image"

# Issue #18: Implement streaming czkawka output parsing
update_issue 18 \
"**Tasks Center (spec 5.5):**
- [ ] Show duplicate detection progress in real-time
- [ ] Display groups found count as parsing progresses
- [ ] Update library with new duplicate groups incrementally" \
"**E2E Test:** Streaming progress in UI
- [ ] Start import with many duplicates
- [ ] Verify Tasks shows 'Duplicate Detect' step progress
- [ ] Verify duplicate count increases as step runs
- [ ] Library should show items before step completes"

# Issue #19: Implement checkpoint/resume for imports
update_issue 19 \
"**Tasks Center (spec 5.5):**
- [ ] Show 'Resume' button for cancelled/interrupted jobs
- [ ] Display checkpoint progress (e.g., '500/1000 files processed')
- [ ] Option to 'Reset and restart' vs 'Resume'" \
"**E2E Test:** Resume functionality via UI
- [ ] Start import, cancel mid-way via Cancel button
- [ ] Verify 'Resume' button appears in Tasks
- [ ] Click Resume, verify import continues from checkpoint
- [ ] Verify final count matches expected total"

# Issue #20: Implement proper CancellationToken propagation
update_issue 20 \
"**Tasks Center (spec 5.5):**
- [ ] Cancel button visible during all pipeline steps
- [ ] Cancel should stop within reasonable time (<5s)
- [ ] Show 'Cancelling...' state before 'Cancelled'" \
"**E2E Test:** Cancel behavior via UI
- [ ] Start import, click Cancel during fingerprint step
- [ ] Verify step stops and job shows 'Cancelled'
- [ ] Verify partial results are preserved in library
- [ ] Test cancel during different pipeline steps"

# Issue #21: Add per-step status tracking in Asset
update_issue 21 \
"**Tasks Center (spec 5.5):**
- [ ] Show which steps completed for each asset
- [ ] Progress bar shows overall and per-step completion
- [ ] Step status icons (✅ complete, 🔄 running, ⏳ pending)" \
"**E2E Test:** Step progress display
- [ ] Start import, verify step list shows in Tasks
- [ ] Each step shows count (e.g., 'Fingerprint: 50/100')
- [ ] Completed steps show checkmark
- [ ] Current step shows spinner/progress"

# Issue #22: Implement metadata merge audit trail
update_issue 22 \
"**Inspector Metadata Donors Tab (spec 5.4):**
- [ ] Show merge decision for each field
- [ ] Display all candidate values with sources
- [ ] Allow user to override selected value
- [ ] Show confidence score if available" \
"**E2E Test:** Audit trail in UI
- [ ] Import fixture with conflicting metadata sources
- [ ] Open Metadata Donors tab, verify all sources listed
- [ ] Verify winning value highlighted
- [ ] Change selected value, verify ChangeRecord created"

# Issue #23: Add import profiles (Safe/Standard/Aggressive)
update_issue 23 \
"**Import Wizard Step 2 (spec 5.2):**
- [ ] Profile selector dropdown (Safe/Standard/Aggressive)
- [ ] Selecting profile toggles appropriate modules
- [ ] Show description for each profile
- [ ] Allow customizing after profile selection" \
"**E2E Test:** Profile selection in wizard
- [ ] Open import wizard, verify profile dropdown
- [ ] Select 'Safe' profile, verify only basic modules enabled
- [ ] Select 'Aggressive', verify face/object recognition enabled
- [ ] Customize after profile, verify changes persist"

# Issue #24: Implement idempotent pipeline operations
update_issue 24 \
"**Tasks Center (spec 5.5):**
- [ ] 'Re-run' button for completed steps
- [ ] Show 'No changes' if re-run produces same results
- [ ] Option to force full re-process" \
"**E2E Test:** Idempotent re-run via UI
- [ ] Complete an import, then re-run same step
- [ ] Verify results are identical
- [ ] Verify re-run is fast (uses cached data)
- [ ] Force re-process, verify full processing occurs"

# Issue #25: Add error retry mechanism
update_issue 25 \
"**Tasks Center (spec 5.5):**
- [ ] Show error count in job summary
- [ ] 'Retry Failed' button for jobs with errors
- [ ] Group errors by type with retry controls" \
"**E2E Test:** Error retry via UI
- [ ] Import fixtures including a corrupted file
- [ ] Verify error shown in Tasks with file name
- [ ] Click 'Retry Failed', verify retry attempted
- [ ] Verify successful items not re-processed"

# Issue #26: Implement incremental import (new files only)
update_issue 26 \
"**Import Wizard (spec 5.2):**
- [ ] Show 'X new files found' when re-importing folder
- [ ] Option to include/skip already-imported files
- [ ] Progress shows only new files being processed" \
"**E2E Test:** Incremental import via UI
- [ ] Import folder A, complete
- [ ] Add new files to folder A
- [ ] Re-import folder A, verify only new files processed
- [ ] Verify count shows 'X new files'"

# Issue #27: Add parallel processing with bounded concurrency
update_issue 27 \
"**Settings Panel:**
- [ ] Concurrency slider/input in Settings
- [ ] Show current CPU/IO usage indicator
- [ ] Option to pause processing to reduce system load" \
"**E2E Test:** Concurrency settings via UI
- [ ] Open Settings, adjust concurrency limit
- [ ] Start import, verify processing respects limit
- [ ] Pause processing, verify it stops gracefully"

# Issue #28: Implement progress ETA calculation
update_issue 28 \
"**Tasks Center (spec 5.5):**
- [ ] Show ETA for each running step
- [ ] Display throughput (files/min)
- [ ] Update ETA as processing continues" \
"**E2E Test:** ETA display in Tasks
- [ ] Start large import
- [ ] Verify ETA displayed and updates over time
- [ ] Verify throughput shown (e.g., '50 files/min')
- [ ] ETA should converge to accurate estimate"

# Issue #29: Add dry-run support to import
update_issue 29 \
"**Import Wizard Step 4 (spec 5.2):**
- [ ] 'Dry Run' button alongside 'Start Import'
- [ ] Show preview of what would be imported
- [ ] Display duplicate groups that would be created
- [ ] No actual changes made during dry-run" \
"**E2E Test:** Dry-run via UI
- [ ] Click 'Dry Run' in import wizard
- [ ] Verify preview shows file count and duplicate count
- [ ] Verify library unchanged after dry-run
- [ ] Click 'Start Import' after dry-run, verify actual import works"

# Issue #30: Implement facet indexing step
update_issue 30 \
"**Filter Sidebar (spec 5.3):**
- [ ] Show facet counts (e.g., 'Camera: Nikon (50), Canon (30)')
- [ ] Facets update as new items are indexed
- [ ] Click facet to filter library" \
"**E2E Test:** Facets in filter UI
- [ ] Import diverse fixtures (different cameras, dates, locations)
- [ ] Verify filter sidebar shows facets with counts
- [ ] Click a camera facet, verify library filters
- [ ] Verify counts update after new import"

# Issue #31: Implement Inspector panel Details tab
update_issue 31 \
"**Inspector Details Tab (spec 5.4):**
- [ ] Show canonical filename, date/time, location
- [ ] Display camera model, dimensions, file size
- [ ] Show AI keywords/tags if available
- [ ] Indicate confidence warnings" \
"**E2E Test:** Details tab content
- [ ] Click image in library, verify Inspector opens
- [ ] Verify Details tab shows all expected metadata
- [ ] Test with various file types (JPEG, HEIC, video)
- [ ] Verify warnings shown for estimated dates"

# Issue #32: Implement Inspector Duplicates tab
update_issue 32 \
"**Inspector Duplicates Tab (spec 5.4):**
- [ ] List all files in duplicate group
- [ ] Show thumbnail, filename, path, size, resolution
- [ ] Highlight current canonical with score
- [ ] 'Make canonical' button on alternates" \
"**E2E Test:** Duplicates tab interaction
- [ ] Import fixtures with duplicates
- [ ] Open Inspector on duplicate, switch to Duplicates tab
- [ ] Verify all group members listed with scores
- [ ] Click 'Make canonical', verify selection changes"

# Issue #33: Implement Inspector Metadata Donors tab
update_issue 33 \
"**Inspector Metadata Donors Tab (spec 5.4):**
- [ ] Table showing field, value, source for each metadata field
- [ ] Show all candidates if multiple sources
- [ ] Allow selecting different source for a field
- [ ] Show audit trail of changes" \
"**E2E Test:** Metadata donors interaction
- [ ] Import fixture with multiple metadata sources
- [ ] Open Metadata Donors tab
- [ ] Verify all sources shown with their values
- [ ] Change source selection, verify update takes effect"

# Issue #34: Implement Map view with clustering
update_issue 34 \
"**Map View (spec 5.3):**
- [ ] Map with photos plotted by GPS location
- [ ] Cluster markers when zoomed out
- [ ] Click cluster to zoom in or filter
- [ ] Lasso selection tool" \
"**E2E Test:** Map view interaction
- [ ] Switch to Map view from library
- [ ] Verify photos with GPS appear on map
- [ ] Click cluster, verify zoom or filter
- [ ] Lasso select area, verify library filters to selection"

# Issue #35: Implement Timeline view
update_issue 35 \
"**Timeline View (spec 5.3):**
- [ ] Chronological layout grouped by time
- [ ] Zoom levels: day/month/year/decade
- [ ] Event cards for detected clusters
- [ ] Click to expand/filter to that period" \
"**E2E Test:** Timeline view interaction
- [ ] Switch to Timeline view
- [ ] Verify photos grouped by date
- [ ] Zoom in/out, verify grouping changes
- [ ] Click event card, verify filters to that event"

# Issue #36: Implement Calendar heatmap view
update_issue 36 \
"**Calendar Heatmap (spec 5.3):**
- [ ] Calendar grid with days colored by photo count
- [ ] Year view with 365 squares
- [ ] Click day to filter to that day's photos" \
"**E2E Test:** Calendar heatmap interaction
- [ ] Switch to Calendar view
- [ ] Verify days with photos are colored
- [ ] Click a day, verify library filters to that day
- [ ] Verify heatmap legend shows count ranges"

# Issue #37: Implement Table view
update_issue 37 \
"**Table View (spec 5.3):**
- [ ] Spreadsheet-like rows with columns
- [ ] Columns: Date, Filename, Camera, Resolution, Size, etc.
- [ ] Sortable columns
- [ ] Multi-select rows for batch actions" \
"**E2E Test:** Table view interaction
- [ ] Switch to Table view
- [ ] Verify all columns display correct data
- [ ] Click column header to sort
- [ ] Select multiple rows, verify selection works"

# Issue #38: Implement Saved Searches
update_issue 38 \
"**Saved Searches (spec 5.6):**
- [ ] 'Save View' button in top bar
- [ ] Dialog to name the saved search
- [ ] Saved searches in sidebar list
- [ ] Click to reapply filters" \
"**E2E Test:** Saved search workflow
- [ ] Apply filters, click 'Save View'
- [ ] Enter name, save
- [ ] Verify saved search appears in sidebar
- [ ] Clear filters, click saved search, verify filters reapplied"

# Issue #39: Add filter sidebar with facets
update_issue 39 \
"**Filter Sidebar (spec 5.3):**
- [ ] Collapsible facet sections (People, Places, Cameras, etc.)
- [ ] Checkboxes to toggle facet values
- [ ] Search within facet values
- [ ] Show counts next to each value" \
"**E2E Test:** Filter sidebar interaction
- [ ] Verify sidebar displays all facet categories
- [ ] Check a facet value, verify library filters
- [ ] Search within facet, verify matching values shown
- [ ] Verify counts are accurate"

# Issue #40: Implement keyboard navigation
update_issue 40 \
"**Keyboard Shortcuts (spec 5.8):**
- [ ] Cmd/Ctrl+K: focus global search
- [ ] Arrow keys/J/K: navigate grid
- [ ] Enter: open Inspector
- [ ] 1/2/3: select canonical in duplicate group" \
"**E2E Test:** Keyboard navigation
- [ ] Press Cmd+K, verify search focused
- [ ] Use arrow keys to navigate grid
- [ ] Press Enter, verify Inspector opens
- [ ] Press Escape to close Inspector"

# Issue #41: Implement reverse geocoding (offline)
update_issue 41 \
"**Inspector and Filters (spec 5.4, 5.3):**
- [ ] Show place name in Inspector Details (city, country)
- [ ] Places facet in filter sidebar
- [ ] Map view shows location names" \
"**E2E Test:** Geocoding in UI
- [ ] Import fixture with GPS data
- [ ] Open Inspector, verify place name shown
- [ ] Filter by Places facet, verify filtering works
- [ ] Verify map shows location labels"

# Issue #42: Add face detection infrastructure
update_issue 42 \
"**People View (spec TBD) and Inspector:**
- [ ] People grid showing face clusters
- [ ] Face boxes in Inspector/detail view
- [ ] Assign name to face cluster
- [ ] Merge/split clusters" \
"**E2E Test:** Face detection UI
- [ ] Import fixtures with faces
- [ ] Verify People view shows detected clusters
- [ ] Click cluster, verify photos of that person shown
- [ ] Assign name, verify name persists"

# Issue #43: Add object detection infrastructure
update_issue 43 \
"**Objects facet and filters:**
- [ ] Objects facet in filter sidebar (pets, cars, etc.)
- [ ] Object tags in Inspector Details
- [ ] Filter by object type" \
"**E2E Test:** Object detection UI
- [ ] Import fixtures with recognizable objects
- [ ] Verify Objects facet shows detected types
- [ ] Filter by object, verify relevant photos shown"

# Issue #44: Implement event detection clustering
update_issue 44 \
"**Timeline View (spec 5.6):**
- [ ] Event cards on timeline for detected clusters
- [ ] Event label (e.g., 'Weekend in London')
- [ ] Click event to view photos
- [ ] Events facet in sidebar" \
"**E2E Test:** Event detection UI
- [ ] Import fixtures from a multi-day trip
- [ ] Verify Timeline shows event grouping
- [ ] Click event card, verify photos filtered
- [ ] Verify Events facet in sidebar"

# Issue #45: Add AI keyword extraction placeholder
update_issue 45 \
"**Inspector and Filters:**
- [ ] AI-generated keywords in Inspector Details
- [ ] Keywords facet in filter sidebar
- [ ] Visual indicator that keywords are AI-generated" \
"**E2E Test:** AI keywords in UI
- [ ] Import fixtures, enable AI keywords module
- [ ] Verify keywords appear in Inspector
- [ ] Filter by keyword, verify results
- [ ] Verify AI-generated badge on keywords"

# Issue #46: Expand E2E tests for import flow
update_issue 46 \
"- This is a testing issue; UI is tested, not created
- Cover all import wizard steps
- Test progress display and cancellation" \
"**E2E Tests to add:**
- [ ] Complete import wizard from start to finish
- [ ] Verify each wizard step transition
- [ ] Test profile selection and module toggles
- [ ] Test cancel during import
- [ ] Verify imported items appear in library grid"

# Issue #47: Add visual regression tests
update_issue 47 \
"- Capture screenshots of all major UI states
- Compare against baseline images
- Flag visual differences for review" \
"**E2E Tests to add:**
- [ ] Screenshot empty library state
- [ ] Screenshot library with items
- [ ] Screenshot each view (Grid, Map, Timeline, Calendar, Table)
- [ ] Screenshot Inspector with all tabs"

# Issue #48: Add integration test with media fixtures
update_issue 48 \
"- Tests validate data flows correctly to UI
- Use deterministic fixtures with known metadata
- Verify displayed values match fixture data" \
"**E2E Tests to add:**
- [ ] Import known fixture, verify item count in library
- [ ] Open known image, verify metadata matches fixture
- [ ] Verify duplicate groups match expected groupings
- [ ] Verify facet counts match fixture data"

# Issue #49: Set up multi-platform CI
update_issue 49 \
"- E2E tests must run on macOS, Windows, Linux
- Ensure UI renders correctly on all platforms
- Test platform-specific paths and dialogs" \
"**E2E Tests to add:**
- [ ] Run full E2E suite on macOS
- [ ] Run full E2E suite on Windows
- [ ] Run full E2E suite on Linux
- [ ] Verify no platform-specific failures"

# Issue #50: Add coverage reporting
update_issue 50 \
"- Track E2E test coverage of UI components
- Ensure all major UI flows are tested
- Report uncovered UI paths" \
"**E2E Coverage goals:**
- [ ] Import wizard: 100% step coverage
- [ ] Library views: all 5 views tested
- [ ] Inspector: all tabs tested
- [ ] Tasks center: job lifecycle tested"

# Issue #52: Enhance MediaCard with rich metadata display
update_issue 52 \
"**Library Grid (spec 5.3):**
- [ ] Show date overlay on thumbnail
- [ ] Video duration badge
- [ ] Duplicate group indicator
- [ ] Selection checkbox on hover" \
"**E2E Test:** MediaCard display
- [ ] Verify date shown on thumbnails
- [ ] Verify video badge on video items
- [ ] Verify duplicate indicator when applicable
- [ ] Hover over card, verify selection checkbox appears"

# Issue #54: Add Settings panel with Reset Library functionality
update_issue 54 \
"**Settings (spec 5.5):**
- [ ] Reset Library button (clears all data)
- [ ] Confirmation dialog with warning
- [ ] Rebuild Index option
- [ ] Cache management (clear thumbnails)" \
"**E2E Test:** Settings functionality
- [ ] Open Settings, verify Reset Library button
- [ ] Click Reset, verify confirmation dialog
- [ ] Confirm reset, verify library is empty
- [ ] Verify can re-import after reset"

# Issue #56: Add comprehensive E2E tests for Library UI interactions
update_issue 56 \
"- This is a testing issue; UI is tested, not created" \
"**E2E Tests to add:**
- [ ] Click item, verify Inspector opens
- [ ] Double-click item, verify detail view
- [ ] Multi-select items via Shift+click
- [ ] Right-click context menu (if implemented)
- [ ] Scroll through large library, verify virtualization
- [ ] Filter and verify results update"

echo ""
echo "All issues updated with UI and E2E requirements!"
